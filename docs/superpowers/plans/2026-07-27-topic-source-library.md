# 主题来源素材库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主题目录能够保存可独立留存的 X 原始内容，并支持 AI 甄选、手动管理和每日十条候选。

**Architecture:** 在创作资产层增加主题入库规则，规则关联 X 订阅、目标目录和关键词。导入任务从 XPost 读取内容快照，先关键词初筛、再由 AI worker 判定，最后由 API 以规范化 URL 或内容 SHA-256 去重写入 CreativeAsset。前端在文章素材视图提供手动 CRUD、规则配置与每日候选。

**Tech Stack:** FastAPI、SQLAlchemy async、SQLite/PostgreSQL、Next.js、TypeScript、AI SDK、Vitest、pytest。

## Global Constraints

- 文章素材只保存原始 `content` 与可选 `url`，不保存作者、发布时间或采集时间。
- 有 URL 时以去片段、去 utm 参数的规范化 URL 去重；无 URL 时以规范化内容 SHA-256 去重。
- 删除 X 采集记录不得删除已入库素材。
- `.superpowers/brainstorm/` 为用户工作区内容，不删除、不提交。

---

### Task 1: 文章素材 CRUD 与唯一性

**Files:**
- Modify: `backend/routers/assets.py`
- Modify: `backend/tests/test_asset_directories_router.py`
- Modify: `web/lib/api/assets.ts`
- Modify: `web/app/assets/AssetsClient.tsx`

- [ ] **Step 1: 写出 URL 规范化和无 URL 内容哈希去重的失败测试。**
- [ ] **Step 2: 运行 `pytest backend/tests/test_asset_directories_router.py -q`，确认新断言失败。**
- [ ] **Step 3: 实现文章创建、编辑时的同目录唯一性校验。**
- [ ] **Step 4: 运行上述 pytest，确认通过。**
- [ ] **Step 5: 在文章素材界面实现内容必填、URL 可空的新增、编辑、删除。**
- [ ] **Step 6: 运行 `npm test -- app/assets`，确认前端测试通过。**

### Task 2: 主题规则与 AI 入库任务

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/routers/assets.py`
- Modify: `backend/tests/test_asset_directories_router.py`
- Modify: `web/lib/api/assets.ts`
- Create: `web/lib/ai/topic-source-job.ts`
- Modify: `web/scripts/content-worker.ts`

- [ ] **Step 1: 写出规则创建、关键词预筛和 worker 回写素材的失败 API 测试。**
- [ ] **Step 2: 运行对应 pytest，确认失败原因是缺少规则/端点。**
- [ ] **Step 3: 增加 TopicSourceRule 表和规则 API，并以 ContentJob 入队。**
- [ ] **Step 4: 增加 AI worker：读取待甄选内容、逐项返回接受 ID、调用回写端点。**
- [ ] **Step 5: 运行 API 测试，确认同 URL/内容的重复回写不会创建副本。**

### Task 3: 每日候选与前端规则管理

**Files:**
- Modify: `backend/routers/assets.py`
- Modify: `web/lib/api/assets.ts`
- Modify: `web/app/assets/AssetsClient.tsx`
- Test: `web/app/assets/assets-system-directory.test.tsx`

- [ ] **Step 1: 写出每日候选端点只返回当前主题最多十条文章素材的失败测试。**
- [ ] **Step 2: 实现候选查询与规则配置 UI。**
- [ ] **Step 3: 运行前端单测和 `npm run build`。**
- [ ] **Step 4: 运行相关 pytest 与 TypeScript 生产构建，记录实际结果。**

## Self-review

- 主题目录、原始内容快照、URL/内容去重、手动 CRUD、关键词初筛、AI 最终判断和每日十条候选均有实现任务。
- 未引入作者、发布时间或采集记录的依赖字段。
- AI 判断通过耐久 ContentJob 执行，失败可在现有任务中心观察和重试。

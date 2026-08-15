# 文件夹级 AI 素材入库 Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: 将 X 素材入库改造成“文件夹级 AI 规则 + X 订阅多文件夹选择 + 每条帖子单文件夹归类”。

Architecture: 文章素材文件夹保存唯一 AI 入库配置；X 订阅通过关联表选择多个已配置文件夹。每个订阅的新帖批次只创建一个合并分类任务，AI 返回一个候选文件夹 ID 或 null，后端以订阅/帖子唯一决策约束防止重复落库。旧规则、旧决策和旧 job 输入保留兼容，新采集只走新关联链路。

Tech Stack: FastAPI, SQLAlchemy async, PostgreSQL, Next.js/React, TypeScript, Vitest, pytest, AI SDK。

## Global Constraints

- 规则属于素材文件夹，不新增用户可见的全局规则库页面。
- X 订阅只选择多个文章文件夹；一次分析中每条帖子最多进入一个文件夹。
- 后端必须校验 AI 返回的文件夹属于该订阅已选择且启用 AI 入库的文件夹。
- 旧订阅级规则和历史判断记录自动迁移；旧 /assets/topic-rules/* 接口和旧 job 输入继续可读。
- 只运行本次改动相关的聚焦测试，不运行全量测试。
- 所有生产代码先有失败测试，再做最小实现。
- 不提交当前工作树；工作区已有大量用户修改，使用 git diff --check 和文件级 diff 校验。

---

## 文件地图

### Backend

- Modify: backend/models.py — 文件夹 AI 配置、X 订阅-文件夹关联、单帖子新决策模型。
- Modify: backend/database.py — 新字段/表创建和旧 TopicSourceRule 数据迁移。
- Modify: backend/routers/assets.py — 文件夹规则 API、新候选/决策 API、删除保护。
- Modify: backend/routers/x.py — X 订阅多文件夹输入/输出、关联替换和删除清理。
- Modify: backend/topic_source_service.py — 每订阅一个合并分类 job。
- Create/modify: backend/tests/test_asset_ingestion_migration.py, backend/tests/test_asset_directories_router.py, backend/tests/test_x_router.py, backend/tests/test_topic_source_service.py。

### Frontend

- Modify: web/lib/api/assets.ts — 文件夹规则类型和保存 API。
- Modify: web/lib/api/x.ts — ingestion_directory_ids 类型和订阅输入。
- Modify: web/app/assets/AssetsClient.tsx — 文件夹新增/编辑对话框中的 AI 配置。
- Modify: web/app/assets/AssetDirectoryRail.tsx — 可选的 AI 规则状态标识。
- Modify: web/app/x/XSubscriptionDialog.tsx — 多文件夹选择，删除旧内嵌规则编辑器。
- Modify: web/app/x/XClient.test.tsx, web/app/x/XSubscriptionDialog.test.tsx, web/app/assets/AssetsClient.test.tsx。
- Modify: web/lib/ai/topic-source-job.ts, web/lib/ai/topic-source-job.test.ts — 合并提示词和单目录分类协议。

## Task 1: Durable schema and old-data migration

Files: backend/models.py, backend/database.py, backend/tests/test_asset_ingestion_migration.py。

Interfaces:

- CreativeAssetDirectory.ai_ingestion_enabled: bool
- CreativeAssetDirectory.ai_ingestion_keywords: list
- CreativeAssetDirectory.ai_ingestion_prompt: str
- XSubscriptionIngestionDirectory(subscription_id, directory_id, created_at) with unique (subscription_id, directory_id)
- AssetIngestionDecision(subscription_id, tweet_id, directory_id nullable, created_at) with unique (subscription_id, tweet_id)
- migrate_asset_ingestion_schema(conn)

- [ ] Step 1: Write failing migration tests

Seed old TopicSourceRule rows pointing at one article folder, with different updated_at values, plus an old TopicSourceDecision. Assert the newest enabled rule populates the folder prompt/keywords, its subscription gets an association, and the old decision maps to the new folder ID. Run the migration twice and assert counts stay unchanged.

~~~python
assert directory.ai_ingestion_prompt == "最新提示词"
assert association.directory_id == directory.id
assert decision.directory_id == directory.id
~~~

- [ ] Step 2: Verify RED

Run /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_asset_ingestion_migration.py -q. It must fail because the new models/migration are absent.

- [ ] Step 3: Implement the models and migration

Add the fields/models near CreativeAssetDirectory and TopicSourceRule. Add missing directory columns in init_db(). Migration behavior: find/create article directories by old names; copy the newest enabled old rule per directory; insert enabled subscription-directory associations; map old decisions to (subscription_id, tweet_id, directory_id); use deterministic existence checks or PostgreSQL conflict-safe inserts so restart is idempotent. Keep old tables untouched.

- [ ] Step 4: Verify GREEN

Run the migration test plus backend/tests/test_topic_source_rule_contract.py. Confirm selected tests pass.

## Task 2: Folder-level rule API and deletion protection

Files: backend/routers/assets.py, backend/tests/test_asset_directories_router.py。

Interfaces:

- Directory list output includes ai_ingestion_enabled, ai_ingestion_keywords, ai_ingestion_prompt.
- PUT /api/assets/directories/{directory_id}/ingestion-rule accepts {enabled, keywords, prompt}.
- GET /api/assets/directories/{directory_id}/ingestion-rule returns the same rule state.

- [ ] Step 1: Write failing router tests

Test rule round-trip, keyword trimming, empty prompt rejection when enabling, media-directory rejection, rename preserving the rule, and deletion returning 409 when the folder has an active rule or X association.

~~~python
response = client.put(
    f"/api/assets/directories/{directory_id}/ingestion-rule",
    json={"enabled": True, "keywords": [" AI ", "工具"], "prompt": "只接受有实际用法的内容。"},
)
assert response.json()["directory_id"] == directory_id
~~~

- [ ] Step 2: Verify RED

Run /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_asset_directories_router.py -k "ingestion or directory" -q. New assertions must fail.

- [ ] Step 3: Implement the API

Extend _directory_payload and DirectoryOut; add dedicated Pydantic input/output schemas; normalize keywords and require a non-empty prompt for enabled rules. Add a helper checking XSubscriptionIngestionDirectory before deleting a directory or descendant. Return clear 409/422 errors.

- [ ] Step 4: Verify GREEN

Run the same focused router command and confirm selected tests pass.

## Task 3: X subscription multi-folder association

Files: backend/routers/x.py, backend/tests/test_x_router.py。

Interfaces:

- SubscriptionOut.ingestion_directory_ids: list[int]
- SubscriptionCreate.ingestion_directory_ids: list[int] = []
- SubscriptionPatch.ingestion_directory_ids: list[int] | None; supplied means full replacement.

- [ ] Step 1: Write failing X API tests

Create two configured article folders, create a subscription with both IDs, assert both IDs in the response, PATCH with one ID and assert replacement, reject disabled/unconfigured/media directories with 422, then delete the subscription and assert associations are removed.

- [ ] Step 2: Verify RED

Run /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py -k "subscription and (directory or ingestion)" -q. The new contract must fail.

- [ ] Step 3: Implement validation and replacement

Add replace_ingestion_directories(db, subscription_id, directory_ids) that de-duplicates IDs, verifies article type plus enabled/non-empty prompt, deletes old rows, and inserts new rows. Call it after subscription flush() on create and before commit on PATCH. Query association IDs in _to_out; explicitly delete them with a subscription.

- [ ] Step 4: Verify GREEN

Run the same focused X command and confirm selected tests pass.

## Task 4: One merged job and new candidate/accepted endpoints

Files: backend/topic_source_service.py, backend/routers/assets.py, backend/tests/test_topic_source_service.py, backend/tests/test_asset_directories_router.py。

Interfaces:

- dispatch_topic_source_posts creates at most one job per subscription/fresh batch with:

~~~json
{"subscription_id": 1, "directory_ids": [11, 12], "tweet_ids": ["tweet-1", "tweet-2"]}
~~~

- GET /api/assets/ingestion/candidates accepts subscription_id, repeated directory_ids, and optional repeated tweet_ids; returns directories and posts.
- POST /api/assets/ingestion/accepted accepts subscription_id and decisions: [{tweet_id, directory_id}]; worker authentication remains required.

- [ ] Step 1: Write failing service/API tests

Configure two folders for one subscription and assert exactly one job with both IDs. Assert candidates include posts matching either folder's keywords, omit already decided posts, reject unassociated directories, and save one asset when a classification selects one folder.

- [ ] Step 2: Verify RED

Run /home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_topic_source_service.py backend/tests/test_asset_directories_router.py -k "topic_source or ingestion" -q. The old service should produce the wrong job count and the new endpoint should be absent.

- [ ] Step 3: Implement the merged chain

Make dispatch join the subscription-directory association with configured article directories, return no job when none are selected, and use an idempotency key based on subscription plus normalized fresh-post IDs. Candidate filtering keeps a post when it matches at least one selected folder's keywords. The accepted endpoint validates worker auth, associations, candidate posts, duplicate decisions, and one nullable/valid directory per post; inserts one decision and one deduplicated article asset in one transaction. Keep old /topic-rules/* helpers for old jobs.

- [ ] Step 4: Verify GREEN

Run the same focused backend command and confirm one merged job and single-folder writes.

## Task 5: AI worker classification protocol

Files: web/lib/ai/topic-source-job.ts, web/lib/ai/topic-source-job.test.ts。

Interfaces:

- buildTopicSourceInstructions(directories) lists every folder and requires exactly one directory_id or null.
- parseTopicSourceClassification(text) returns { classifications: Array<{tweet_id: string; directory_id: number | null}> }.

- [ ] Step 1: Write failing worker tests

Test valid JSON, non-integer directory rejection, duplicate tweet classification rejection, and an instruction containing the one-folder-or-null constraint.

~~~json
{"classifications":[{"tweet_id":"tweet-a","directory_id":11},{"tweet_id":"tweet-b","directory_id":null}]}
~~~

- [ ] Step 2: Verify RED

Run cd web && pnpm exec vitest run lib/ai/topic-source-job.test.ts. New parser/instruction assertions must fail because the worker expects accepted_tweet_ids.

- [ ] Step 3: Implement the new path with legacy fallback

For input containing subscription_id and directory_ids, fetch the new candidates endpoint, send all folder rules in one prompt, parse classifications, validate IDs against returned folders/posts, fill omitted posts with null, and submit the complete decision list to the new accepted endpoint. Keep the old rule_id path and parser for already queued jobs.

- [ ] Step 4: Verify GREEN

Run the same Vitest command and confirm all selected worker tests pass.

## Task 6: Assets folder rule UI

Files: web/lib/api/assets.ts, web/app/assets/AssetsClient.tsx, web/app/assets/AssetDirectoryRail.tsx, web/app/assets/AssetsClient.test.tsx。

Interfaces:

- CreativeAssetDirectory carries the three AI fields.
- updateCreativeAssetDirectoryIngestionRule(id, body) calls the new PUT endpoint.

- [ ] Step 1: Write failing UI tests

Assert article-folder edit shows enable/keyword/prompt controls, saving calls the rule API with trimmed values, and media-folder dialogs do not show article AI controls.

- [ ] Step 2: Verify RED

Run cd web && pnpm exec vitest run app/assets/AssetsClient.test.tsx. New assertions must fail.

- [ ] Step 3: Implement folder configuration

Extend directory dialog state from existing directory payloads, render AI controls only for article folders, save name and rule configuration in the same user action, update local directories from returned payload, and add a small Sparkles/status marker in the rail without changing navigation state.

- [ ] Step 4: Verify GREEN and lint

Run the focused Vitest command, then cd web && pnpm exec eslint app/assets/AssetsClient.tsx app/assets/AssetDirectoryRail.tsx lib/api/assets.ts.

## Task 7: X multi-folder selector UI

Files: web/lib/api/x.ts, web/app/x/XSubscriptionDialog.tsx, web/app/x/XClient.tsx, web/app/x/XSubscriptionDialog.test.tsx, web/app/x/XClient.test.tsx。

Interfaces:

- XSubscription.ingestion_directory_ids: number[]
- CreateXSubscriptionInput.ingestion_directory_ids?: number[]
- XSubscriptionPatch.ingestion_directory_ids?: number[]

- [ ] Step 1: Write failing UI tests

Mock two enabled folders and one unavailable folder. Assert enabled folders are selectable, unavailable folders are disabled with a reason, selected IDs are submitted on create/edit, and old “保存入库规则”/“AI 筛选入库” controls are absent.

- [ ] Step 2: Verify RED

Run cd web && pnpm exec vitest run app/x/XSubscriptionDialog.test.tsx app/x/XClient.test.tsx. New assertions must fail because the dialog still uses TopicSourceRule.

- [ ] Step 3: Implement the selector

Load listCreativeAssetDirectories('article') when the dialog opens. Remove old topic-rule states/imports/manual screening. Render a checkbox/card list keyed by directory ID, show prompt summaries, disable folders without an enabled prompt, initialize from ingestion_directory_ids, and include selected IDs in both create and edit submit bodies.

- [ ] Step 4: Verify GREEN and lint

Run the focused Vitest command, then cd web && pnpm exec eslint app/x/XSubscriptionDialog.tsx app/x/XClient.tsx lib/api/x.ts.

## Task 8: Focused integration verification

Files: only files from Tasks 1–7.

- [ ] Step 1: Run focused backend verification

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_asset_ingestion_migration.py \
  backend/tests/test_asset_directories_router.py \
  backend/tests/test_topic_source_service.py \
  backend/tests/test_x_router.py -q
~~~

Expected: selected tests pass; unrelated baseline failures are reported separately.

- [ ] Step 2: Run focused frontend verification

~~~bash
cd web && pnpm exec vitest run \
  lib/ai/topic-source-job.test.ts \
  app/assets/AssetsClient.test.tsx \
  app/x/XSubscriptionDialog.test.tsx \
  app/x/XClient.test.tsx
~~~

- [ ] Step 3: Check diff hygiene

Run git diff --check on changed files. Review the diff for accidental edits to existing dirty files and verify the X dialog has no TopicSourceRule imports.

- [ ] Step 4: Rendered smoke check

The flow under test is: /assets → edit an article folder → save an AI rule, then /x → edit a subscription → select multiple configured folders → save and reopen to verify selections. Browser plugin is unavailable, so use the already running local Next server and a temporary Playwright script outside the repository; inspect console errors and capture screenshots outside the repository.

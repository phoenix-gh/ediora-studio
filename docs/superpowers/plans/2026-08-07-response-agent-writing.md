# 情报中心 Agent 写作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将情报中心“值得写”的 `content_response_output` Job 升级为真正的 Agent 写作，并让 Agent 直接使用现有 `save_draft` 工具创建唯一草稿。

**Architecture:** 保留现有响应输出和 Job flow。Worker 读取完整原文与 AI 评价后创建持久化 AgentExecution，使用受限的全局只读工具、Skill 工具和现有 `save_draft` 运行 Agent；Worker 取得真实 `draft_id` 后通过 Worker-only 幂等关联接口更新响应输出，不再调用会重复创建草稿的旧 `worker-result` 保存路径。

**Tech Stack:** Next.js/TypeScript Worker、AI SDK `openAgentRuntime`、MCP tools、FastAPI、SQLAlchemy、Vitest、pytest。

## Global Constraints

- 保留 `flow=content_response_output`、现有“值得写”入口、输出记录和任务看板入口。
- Agent 不使用新的 `save_response_article` 工具；必须复用现有 `save_draft` MCP 工具。
- Agent 只能看到全局只读工具、`loadSkill`、`readSkillReference` 和 `save_draft`；`save_draft` 是本任务唯一允许的写入工具。
- Skill 是否使用、使用哪个 Skill，完全由 Agent 根据上下文自主判断；不能因为任务文本提及 Skill 就强制激活。
- 只有 `save_draft` 返回的真实草稿 ID 才能完成 Agent step；普通模型文本不能完成 Job。
- Agent 已保存草稿但关联失败时，重试只能恢复并执行关联，不能再次调用模型或 `save_draft`。
- 保留旧 `worker-result` 创建草稿接口，兼容已有普通 Worker 结果。
- 不修改、不暂存、不提交工作区中与本任务无关的既有用户改动；本次执行不创建 commit。

---

### Task 1: 增加已有草稿的 Worker 幂等关联接口

**Files:**
- Modify: `backend/routers/responses.py:77-82`，增加 Worker link request schema
- Modify: `backend/routers/responses.py:338-405`，在现有 worker-result 附近增加 link route
- Test: `backend/tests/test_responses_router.py:260`，补充 Agent 已保存草稿后的关联测试

**Interfaces:**
- Consumes: `ContentResponseOutput`, `ContentResponseItem`, `ArticleDraft` 和现有 Worker token 认证。
- Produces: `POST /api/responses/outputs/{output_id}/worker-link`，请求体 `{"article_draft_id": int}`，返回 `id`、`status`、`article_draft_id`。

- [ ] **Step 1: Write the failing tests**

新增测试覆盖以下真实行为：

```python
def test_worker_link_reuses_agent_saved_draft_without_creating_another(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    output_id = queued.json()["outputs"][0]["id"]
    draft = client.post("/api/write/drafts", json={
        "topic_id": f"response:{item_id}",
        "title": "Agent 文章",
        "content": "# Agent 文章\n\n这是完整正文。",
        "status": "drafting",
        "draft_type": "article",
    })
    assert draft.status_code == 201, draft.text
    draft_id = draft.json()["id"]

    response = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
        json={"article_draft_id": draft_id},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": output_id,
        "status": "draft_ready",
        "article_draft_id": draft_id,
    }
```

同时增加：重复关联同一草稿返回相同结果；错误 `topic_id`、空正文、非文章草稿、不同草稿冲突和缺少 Worker token 均被拒绝。

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py -k worker_link -q
```

Expected: FAIL because the new route does not exist yet.

- [ ] **Step 3: Implement the minimal link contract**

在 `responses.py` 中增加 `WorkerLinkIn`，并实现 Worker-protected route：

1. 使用 `select(ContentResponseOutput).where(...).with_for_update()` 锁定输出。
2. 读取响应项和草稿；不存在时分别返回 404/409。
3. 要求草稿 `topic_id == f"response:{item.id}"`、`draft_type == "article"`、`content.strip()` 非空。
4. 已是 `draft_ready` 时只有同一 `article_draft_id` 才幂等成功，不同 ID 返回 409。
5. 将来源 URL/标题补入草稿 `sources`，设置输出的 `article_draft_id`、`source_attribution`、`status="draft_ready"` 并清空错误字段。
6. 响应项没有目标时设置 `destination_type="draft"`、`destination_id`，写入一次 `destination_created` 事件；已有相同目标时不重复事件，已有其他目标时返回冲突。
7. 提交并返回固定三字段结果。

- [ ] **Step 4: Run the tests to verify they pass**

Run the focused response tests again:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py -k "worker_link or worker_result" -q
```

Expected: new link tests and existing worker-result idempotency tests pass.

---

### Task 2: 给共享 Agent runtime 增加工具可见性过滤

**Files:**
- Modify: `web/lib/ai/agent-runtime.ts:25-55,120-310`
- Modify: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Consumes: existing `ChatSkillRuntime.tools` and `OpenAgentRuntimeOptions`。
- Produces: optional `allowedToolNames?: readonly string[]`；设置后，模型请求、Skill plan catalog、required-tool 检查和 runtime.tools getter 都只使用允许的工具。

- [ ] **Step 1: Write the failing test**

在共享 Agent runtime 测试中构造 `search_assets`、`save_draft`、`update_draft` 三个工具，打开 runtime 时传入：

```ts
allowedToolNames: ['search_assets', 'save_draft']
```

断言 `Object.keys(runtime.tools)` 不含 `update_draft`，并断言 `requiredTools: ['update_draft']` 在模型调用前抛出 `Required Agent tool is unavailable: update_draft`。

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd web
pnpm test -- lib/ai/agent-runtime.test.ts -t "allowed tool"
```

Expected: FAIL because `OpenAgentRuntimeOptions` 没有工具过滤契约。

- [ ] **Step 3: Implement the minimal runtime filter**

在 `OpenAgentRuntimeOptions` 增加 `allowedToolNames`，在 `openAgentRuntime` 内集中定义：

```ts
const visibleTools = () => {
  if (!options.allowedToolNames) return registry.tools
  const allowed = new Set(options.allowedToolNames)
  return Object.fromEntries(
    Object.entries(registry.tools).filter(([name]) => allowed.has(name)),
  ) as ToolSet
}
```

将 `visibleTools()` 用于：

- required tool availability 检查；
- 无 Skill 执行的 `tools`；
- Skill plan 的 `planningTools`；
- Skill execution 的 `tools` 和 `activeTools`；
- runtime 返回的 `tools` getter。

不要修改 `ChatSkillRuntime` 的内部状态；Skill 激活后重新打开 registry 时仍通过同一个过滤函数取可见工具。

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web
pnpm test -- lib/ai/agent-runtime.test.ts
```

Expected: all shared runtime tests pass, including existing automatic Skill selection and message logging tests.

---

### Task 3: 把 response output Worker 改成 Agent runner

**Files:**
- Modify: `web/lib/ai/agent-runtime-types.ts:29-36`
- Modify: `web/lib/ai/content-response-output-job.ts:1-133`
- Test: `web/lib/ai/content-response-output-job.test.ts`

**Interfaces:**
- Consumes: `GET /responses/outputs/{output_id}/worker-context`、现有 Agent execution client、MCP `save_draft`。
- Produces: 保持 `runContentResponseOutputJob(jobId: number)` 导出名不变；新增 `buildResponseArticleAgentObjective` 和 response save evidence parser，供测试和 Worker recovery 使用。

- [ ] **Step 1: Write failing Agent runner tests**

使用与 `daily-creation-agent-job.test.ts` 相同的依赖注入方式，新增测试：

1. objective 含原文、AI 评价、完整 Markdown、`topic_id=response:{id}`、`status=drafting`、`draft_type=article`、禁止发布和自主 Skill 选择。
2. Agent 只返回普通文本、没有 `save_draft` 成功审计时失败，且不调用 link/completeJob。
3. `save_draft` 返回 `{structuredContent:{result:{id:123,title:"...",status:"drafting"}}}` 时，Agent step 产生 `draftId=123` evidence，并调用 `linkDraft(jobId, outputId, 123)`。
4. 已持久化的成功 `save_draft` tool call 可以恢复；`loadModel` 和 runtime 不再调用，只执行 link。
5. link 失败后 Job 失败；再次运行从已成功的 Agent step 恢复，不重复调用 `save_draft`。

最小成功 fixture 的工具审计必须类似：

```ts
{
  toolName: 'save_draft',
  toolCallId: 'save-1',
  status: 'succeeded',
  sideEffecting: true,
  autoApproved: true,
  output: { structuredContent: { result: {
    id: 123, title: '完整文章', status: 'drafting', created_at: '2026-08-07T00:00:00Z',
  } } },
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd web
pnpm test -- lib/ai/content-response-output-job.test.ts -t "Agent|save_draft|draft link"
```

Expected: FAIL because the current runner calls plain `generateText` and has no Agent execution or save evidence contract。

- [ ] **Step 3: Add response completion evidence and objective**

将 `AgentCompletionEvidence` 扩展为联合类型，保留 daily creation 的原有分支，并增加：

```ts
type ResponseArticleCompletionEvidence = {
  toolName: 'save_draft'
  toolCallId: string
  draftId: number
  responseItemId: number
}
```

在 `content-response-output-job.ts` 增加：

- `ResponseArticleContext` 类型，至少覆盖 `output.id`、`output.output_type`、`item.id`、`item.source_url`、`item.source_title`、`item.analysis` 和完整 `source`；
- `buildResponseArticleAgentObjective(context, executionId?)`；
- MCP output unwrap helper，兼容 `structuredContent.result`、`content` 文本 JSON 和直接对象；
- `completionEvidenceFromAudit(event, expected)`，只接受成功的 `save_draft` 和正整数 draft ID；response item 绑定由 evidence 携带并由后续 `worker-link` 再次校验，不能只信任 Agent 的工具入参摘要；
- `RESPONSE_AGENT_TOOL_ALLOWLIST`，包括 `web_search`、`fetch_url`、`get_content_directions`、`list_drafts`、`get_draft`、`search_creative_assets`、`get_creative_asset`、`list_creative_asset_candidates`、`get_recent_content_usage`、`list_writing_plans`、`get_writing_plan`、`search_writing_plans`、`list_publish_accounts`、`get_account_profile`、`loadSkill`、`readSkillReference`、`save_draft`。

- [ ] **Step 4: Implement the Agent-backed runner**

保持现有 `prepare_output_context` 兼容逻辑，新增步骤顺序：

```ts
prepare_output_context -> agent -> link_draft
```

Runner 实现要求：

1. 读取 `response_output_id`，读取或恢复 context。
2. 对新 Agent execution 调用 `ensureAgentExecution`，使用 `skillMode: 'auto'`、`automaticSelection: false`、`approvalPolicy: 'automatic'`。
3. `openAgentRuntime` 传入 `allowedToolNames: RESPONSE_AGENT_TOOL_ALLOWLIST`、工具 claim/audit 回调和消息持久化回调。
4. 使用一条包含 objective 和完整 JSON context 的 user model message，`maxSteps: 30`，`requiredTools: ['save_draft']`。
5. `onToolAudit` 完成/失败 AgentToolCall，并从成功的 `save_draft` 审计中提取 evidence。
6. 没有 evidence 时失败 AgentExecution 和 agent step；不使用 `result.text` 作为草稿内容。
7. evidence 成功后完成 AgentExecution 和 agent step，再执行 `link_draft`，调用依赖注入的 `linkDraft(jobId, outputId, draftId)`。
8. link 成功后完成 link step 和 Job；link 失败只失败 link step，保留 Agent 成功状态。
9. 既有旧 Job 若 `save_output` 已成功，直接返回旧结果；其他旧的 generate step 不作为新 Agent completion evidence。

新增依赖接口：

```ts
linkDraft(jobId: number, outputId: number, draftId: number): Promise<Record<string, unknown>>
```

默认实现使用 `apiPost('/responses/outputs/{outputId}/worker-link', {article_draft_id: draftId}, workerHeaders(jobId))`。

- [ ] **Step 5: Run the response Agent tests to verify they pass**

```bash
cd web
pnpm test -- lib/ai/content-response-output-job.test.ts
```

Expected: Agent objective、evidence、link、恢复和错误路径全部通过。

---

### Task 4: 定向回归与交付前验证

**Files:**
- Test only: files changed by Tasks 1–3
- No frontend changes expected: existing `JobLogDialog` already calls `/jobs/{id}/agent-log` and displays Agent messages/tools.

- [ ] **Step 1: Run the focused backend suite**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_responses_router.py \
  backend/tests/test_responses_worker_context.py \
  backend/tests/test_responses_router_contract.py -q
```

Expected: all focused response tests pass.

- [ ] **Step 2: Run the focused TypeScript suite**

```bash
cd web
pnpm test -- \
  lib/ai/agent-runtime.test.ts \
  lib/ai/content-response-output-job.test.ts \
  scripts/content-worker.test.ts
```

Expected: all selected Agent/runtime/worker tests pass, including the existing resolver mapping and old-job compatibility cases.

- [ ] **Step 3: Run lint and static checks for changed TypeScript**

```bash
cd web
pnpm exec eslint lib/ai/agent-runtime.ts lib/ai/agent-runtime-types.ts lib/ai/content-response-output-job.ts lib/ai/content-response-output-job.test.ts scripts/content-worker.ts scripts/content-worker.test.ts
pnpm exec tsc --noEmit --pretty false
```

Expected: changed files have no ESLint errors; any pre-existing unrelated type errors must be reported separately and not called a pass.

- [ ] **Step 4: Run whitespace validation and inspect the diff**

```bash
git diff --check
git status --short
git diff -- backend/routers/responses.py backend/tests/test_responses_router.py web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime-types.ts web/lib/ai/content-response-output-job.ts web/scripts/content-worker.ts
```

Confirm only the requested response Agent implementation and its tests are included; do not stage or commit in this session.

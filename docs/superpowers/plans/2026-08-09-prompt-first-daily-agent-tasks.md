# Prompt-First Daily Agent Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the fixed X-post daily creation workflow with scheduled, editable Agent prompts while retaining the existing form as an optional prompt generator and removing save_daily_creation_outputs from new executions.

**Architecture:** DailyCreationRule.prompt becomes the only business instruction consumed by the worker; schedule fields remain structured. Existing builder fields remain stored only so the UI can restore the quick generator. The daily worker runs the shared Agent runtime with the prompt verbatim, persists generic completion evidence, and never requires a business-specific tool. Historical batch rows remain readable, but the MCP batch-save tool and new batch writes are removed.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy async/PostgreSQL, TypeScript, Next.js/React, AI SDK, Vitest, Testing Library, Pytest.

## Global Constraints

- The final editable prompt is the only business execution source.
- Schedule fields decide when to run and never reinterpret prompt content.
- The quick builder may replace prompt text only after an explicit user action.
- The Agent receives the enabled Skill catalog and global tools and chooses its own workflow.
- save_daily_creation_outputs must not appear in the new MCP tool catalog, worker requirements, or completion evidence.
- Existing daily_creation_output_batches rows remain readable; this change must not drop historical data.
- New prompt-first rules may be created without selecting an asset directory.
- When the quick builder requests X drafts, it must emit the exact tool argument draft_type="x".
- Preserve unrelated changes in the current dirty worktree and stage only files belonging to each task.

---

## File Structure

- Create backend/daily_creation_prompt.py: pure legacy-field-to-prompt conversion.
- Modify backend/models.py and backend/database.py: canonical prompt column and idempotent backfill.
- Modify backend/routers/creation_rules.py and backend/daily_creation_service.py: prompt-first API and immutable run snapshots.
- Modify backend/content_jobs.py: generic job success completes the linked daily run.
- Modify backend/mcp_server.py: remove DailyCreationPostInput and save_daily_creation_outputs.
- Modify web/lib/ai/agent-runtime-types.ts and daily-creation-agent-job.ts: generic completion and prompt execution.
- Create web/app/creation-rules/creation-rule-prompt.ts: deterministic quick prompt generator.
- Modify CreationRuleDialog.tsx, CreationRulesPanel.tsx, and API types: prompt-first UI.
- Update focused backend and frontend tests named in each task.

---

### Task 1: Canonical Prompt Column and Legacy Backfill

**Files:**
- Create: backend/daily_creation_prompt.py
- Modify: backend/models.py:1105
- Modify: backend/database.py:840
- Modify: backend/database.py:1055
- Test: backend/tests/test_daily_creation_rule_schema.py
- Test: backend/tests/test_database_init_postgres.py

**Interfaces:**
- Consumes: legacy rule mappings containing directory, directories, target_count, lookback_days, account_id, instructions, and skill_name.
- Produces: build_legacy_creation_prompt(rule: Mapping[str, object]) -> str and DailyCreationRule.prompt: str.

- [ ] **Step 1: Write the failing prompt conversion test**

~~~python
def test_legacy_creation_rule_builds_self_contained_agent_prompt():
    from daily_creation_prompt import build_legacy_creation_prompt

    prompt = build_legacy_creation_prompt({
        "name": "每日搞钱帖",
        "asset_type": "article",
        "directories": ["搞钱副业"],
        "target_count": 12,
        "lookback_days": 14,
        "account_id": None,
        "instructions": "每句话单独成段",
    })

    assert "创作 12 条中文 X 短帖" in prompt
    assert "搞钱副业" in prompt
    assert "最近 14 天" in prompt
    assert "save_draft" in prompt
    assert 'draft_type="x"' in prompt
    assert "每句话单独成段" in prompt
    assert "save_daily_creation_outputs" not in prompt
~~~

Extend test_init_db_removes_daily_plan_tables_and_backfills_rule_directories to select prompt and assert it is non-empty and contains the old directory plus draft_type="x". Add a malformed legacy row whose target_count cannot be converted and assert migration disables that rule instead of leaving an enabled rule with an empty prompt.

- [ ] **Step 2: Run tests and verify RED**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rule_schema.py backend/tests/test_database_init_postgres.py -q
~~~

Expected: failures because daily_creation_prompt and the prompt column do not exist.

- [ ] **Step 3: Implement the pure formatter**

~~~python
from collections.abc import Mapping


def build_legacy_creation_prompt(rule: Mapping[str, object]) -> str:
    raw = rule.get("directories")
    directories = [
        str(item).strip() for item in raw if str(item).strip()
    ] if isinstance(raw, list) else []
    fallback = str(rule.get("directory") or "").strip()
    if not directories and fallback:
        directories = [fallback]
    count = int(rule.get("target_count") or 1)
    lookback = int(rule.get("lookback_days") or 0)
    lines = [
        f"从创作资产目录 {'、'.join(directories) or '由你自行判断的可用素材'} 中，创作 {count} 条中文 X 短帖。",
        "根据上下文自行选择相关 Skill，并使用工具读取真实素材，不要编造来源。",
    ]
    if lookback > 0:
        lines.append(
            f"检查最近 {lookback} 天的内容使用记录，不要复用仍在去重期内的创作资产。"
        )
    lines.append(
        '每条完成后调用 save_draft 保存到草稿箱，参数必须使用 '
        'status="drafting"、draft_type="x"。'
    )
    extra = str(rule.get("instructions") or "").strip()
    if extra:
        lines.extend(["", "附加要求：", extra])
    return "\n".join(lines).strip()
~~~

- [ ] **Step 4: Add and backfill the model column**

Add prompt: Mapped[str] = mapped_column(Text, nullable=False, default="") to DailyCreationRule.

Add migrate_daily_creation_prompt_schema(conn), which adds prompt TEXT NOT NULL DEFAULT '', reads only rows where trim(prompt) = '', builds text through build_legacy_creation_prompt, and updates each row by ID. If one legacy row cannot be converted, set enabled=FALSE for that row and leave prompt empty so the scheduler cannot execute it. Call the migration from init_db after existing daily rule columns are present.

- [ ] **Step 5: Run tests and verify GREEN**

Run the Task 1 test command again. Expected: zero failures.

- [ ] **Step 6: Commit Task 1**

~~~bash
git add backend/daily_creation_prompt.py backend/models.py backend/database.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_database_init_postgres.py
git commit -m "feat: add canonical prompts to scheduled agent rules"
~~~

---

### Task 2: Prompt-First Rule API and Immutable Run Snapshot

**Files:**
- Modify: backend/routers/creation_rules.py:36
- Modify: backend/routers/creation_rules.py:380
- Modify: backend/daily_creation_service.py:177
- Modify: backend/daily_creation_service.py:487
- Test: backend/tests/test_daily_creation_rules_router.py
- Test: backend/tests/test_daily_creation_rule_schema.py
- Test: backend/tests/test_daily_creation_scheduler.py

**Interfaces:**
- Consumes: CreationRuleIn.prompt and schedule fields.
- Produces: rule responses with prompt and DailyCreationRun.rule_snapshot["prompt"] equal to the submitted text.

- [ ] **Step 1: Write failing API tests**

~~~python
def prompt_rule_payload(**overrides):
    payload = {
        "name": "通用 Agent 日报",
        "prompt": "研究今天的新素材，把值得发布的内容保存到草稿箱。",
        "execution_mode": "recurring",
        "scheduled_time": "09:00",
        "timezone": "Asia/Shanghai",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


def test_prompt_first_rule_does_not_require_asset_directory(client):
    response = client.post("/api/creation-rules", json=prompt_rule_payload())
    assert response.status_code == 201, response.text
    assert response.json()["prompt"] == prompt_rule_payload()["prompt"]
    assert response.json()["directories"] == []


def test_creation_rule_rejects_blank_prompt(client):
    response = client.post(
        "/api/creation-rules", json=prompt_rule_payload(prompt="   ")
    )
    assert response.status_code == 422
~~~

Extend the run-now test to create a run, change the rule prompt, and prove the run snapshot retains the original text.

- [ ] **Step 2: Run tests and verify RED**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_scheduler.py -q
~~~

Expected: prompt-only creation is rejected and snapshots lack prompt.

- [ ] **Step 3: Implement the request contract**

CreationRuleIn gains prompt: str = Field(min_length=1, max_length=20_000). Builder-only fields receive safe defaults. The validator strips prompt and normalizes directories only when a directory value exists; otherwise it persists directory="" and directories=[]. Update _validate_rule_references so an empty builder directory list is valid and no directory query is issued.

CreationRulePatch gains prompt with the same upper bound. _rule_out returns prompt.

- [ ] **Step 4: Snapshot prompt without reinterpreting it**

snapshot_creation_rule includes the exact prompt. create_daily_creation_run sets requested_count=0 because the legacy non-null column is no longer an execution contract. No execution code may rebuild the prompt from builder fields.

- [ ] **Step 5: Run tests and verify GREEN**

Run the Task 2 command again. Expected: zero failures.

- [ ] **Step 6: Commit Task 2**

~~~bash
git add backend/routers/creation_rules.py backend/daily_creation_service.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_scheduler.py
git commit -m "feat: make scheduled rules prompt first"
~~~

---

### Task 3: Generic Scheduled-Agent Execution and Crash-Safe Completion

**Files:**
- Modify: web/lib/ai/agent-runtime-types.ts:29
- Modify: web/lib/ai/daily-creation-agent-job.ts
- Modify: web/lib/ai/daily-creation-agent-job.test.ts
- Modify: web/lib/ai/daily-creation-agent-integration.test.ts

**Interfaces:**
- Consumes: DailyCreationAgentContext.rule.prompt.
- Produces: { kind: "agent_run", executionId, finalText, toolCallCount } and a finalizing checkpoint recoverable without rerunning side effects.

- [ ] **Step 1: Write failing prompt-first runner tests**

~~~typescript
it('passes the saved prompt to the Agent without business instructions', () => {
  const prompt = '检查今天的 GitHub 日榜，并把结论保存到临时文件。'
  expect(buildDailyCreationAgentObjective({
    id: 83,
    status: 'queued',
    rule: { name: '日报', prompt },
  })).toBe(prompt)
})

it('completes a text-only generic Agent run', async () => {
  const deps = dependencies({ text: '研究完成', toolAudits: [] })
  await expect(runDailyCreationAgentJob(19, deps)).resolves.toMatchObject({
    kind: 'agent_run',
    executionId: 41,
    finalText: '研究完成',
    toolCallCount: 0,
  })
  expect(deps.completeJob).toHaveBeenCalledWith(19)
})
~~~

Also add tests proving requiredTools is undefined, a finalizing checkpoint recovers without opening the runtime, and a successful side-effecting call without a final checkpoint fails non-retryably instead of rerunning.

- [ ] **Step 2: Run Vitest and verify RED**

~~~bash
pnpm test -- lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts
~~~

Run from web. Expected: fixed X objective and batch evidence assertions fail.

- [ ] **Step 3: Replace daily batch evidence with generic evidence**

~~~typescript
{
  kind: 'agent_run'
  executionId: number
  finalText: string
  toolCallCount: number
}
~~~

Keep the content-response save_draft evidence member unchanged.

- [ ] **Step 4: Execute the prompt verbatim**

buildDailyCreationAgentObjective returns context.rule.prompt.trim() and rejects blank text. Open the runtime with approvalPolicy automatic, automaticSelection false, and skillMode auto. Call runtime.run with no requiredTools.

After runtime.run:

1. Reject failed or uncertain tool audits.
2. Bound finalText to 2,000 characters.
3. Create generic evidence with the successful tool count.
4. Persist a finalizing checkpoint containing evidence.
5. Complete execution, step, and job.

- [ ] **Step 5: Add restart protection**

If the existing execution checkpoint already contains generic finalizing evidence, complete without reopening the runtime. If no final checkpoint exists but listToolCalls returns a succeeded or uncertain side-effecting call, fail with scheduled Agent interrupted after side effects; review logs before retry and mark it non-retryable.

- [ ] **Step 6: Update the integration fixture**

Replace its save_daily_creation_outputs fixture with save_draft whose schema requires draft_type: z.literal("x"). Verify Skill loading and one X draft save do not cause any framework-added second save.

- [ ] **Step 7: Run tests and verify GREEN**

Run the Task 3 command again. Expected: zero failures.

- [ ] **Step 8: Commit Task 3**

~~~bash
git add web/lib/ai/agent-runtime-types.ts web/lib/ai/daily-creation-agent-job.ts web/lib/ai/daily-creation-agent-job.test.ts web/lib/ai/daily-creation-agent-integration.test.ts
git commit -m "feat: run scheduled tasks from Agent prompts"
~~~

---

### Task 4: Remove the Dedicated Save Tool and Complete Runs from Job State

**Files:**
- Modify: backend/mcp_server.py:35
- Modify: backend/mcp_server.py:500
- Modify: backend/daily_creation_service.py:270
- Modify: backend/content_jobs.py:820
- Modify: backend/routers/creation_rules.py:210
- Test: backend/tests/test_mcp_daily_creation_tools.py
- Test: backend/tests/test_daily_creation_service.py
- Test: backend/tests/test_content_jobs.py
- Test: backend/tests/test_daily_creation_rules_router.py

**Interfaces:**
- Consumes: a successful generic daily_creation job.
- Produces: linked DailyCreationRun.status="succeeded" and no new batch-write tool.

- [ ] **Step 1: Write failing MCP and lifecycle tests**

~~~python
def test_daily_batch_save_tool_is_not_registered():
    names = {tool.name for tool in run(mcp_server.mcp.list_tools())}
    assert "save_daily_creation_outputs" not in names
    assert "save_draft" in names
    assert "record_content_usage" in names
~~~

Add a content job test that succeeds a running daily_creation job and verifies the linked run is succeeded, has the same completed_at, and retains created_count=0.

- [ ] **Step 2: Run tests and verify RED**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_daily_creation_service.py backend/tests/test_content_jobs.py backend/tests/test_daily_creation_rules_router.py -q
~~~

Expected: the tool remains registered and the run remains incomplete.

- [ ] **Step 3: Remove the dedicated tool and new batch writer**

Delete DailyCreationPostInput, the decorated save_daily_creation_outputs function, _batch_result, _normalize_agent_post, _observed_creation_evidence, and persist_daily_creation_output_batch, plus now-unused imports and tests.

Retain DailyCreationOutputBatch in models.py, its database migration, historical draft deletion logic, record_content_usage, get_recent_content_usage, and persist_x_draft_with_usage while legacy read or worker routes still use them.

- [ ] **Step 4: Complete the linked run from succeed_job**

Lock the run by ID and update it only when content_job_id matches and status is queued or running:

~~~python
if job.flow == "daily_creation":
    run_id = (job.input_data or {}).get("run_id")
    if isinstance(run_id, int):
        creation_run = await session.scalar(
            select(DailyCreationRun)
            .where(DailyCreationRun.id == run_id)
            .with_for_update()
        )
        if (
            creation_run is not None
            and creation_run.content_job_id == job.id
            and creation_run.status in {"queued", "running"}
        ):
            creation_run.status = "succeeded"
            creation_run.completed_at = job.completed_at
~~~

- [ ] **Step 5: Keep history summaries generic**

Update _bounded_completion to expose bounded generic keys kind, executionId, finalText, and toolCallCount, while still accepting old outputIds and createdCount when reading historical runs. Keep one historical compatibility assertion using save_daily_creation_outputs, but do not use it in current-flow fixtures.

- [ ] **Step 6: Run tests and verify GREEN**

Run the Task 4 command again. Expected: zero failures.

- [ ] **Step 7: Commit Task 4**

~~~bash
git add backend/mcp_server.py backend/daily_creation_service.py backend/content_jobs.py backend/routers/creation_rules.py backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_daily_creation_service.py backend/tests/test_content_jobs.py backend/tests/test_daily_creation_rules_router.py
git commit -m "refactor: remove daily batch save tool"
~~~

---

### Task 5: Editable Prompt UI with Quick Generator

**Files:**
- Create: web/app/creation-rules/creation-rule-prompt.ts
- Create: web/app/creation-rules/creation-rule-prompt.test.ts
- Modify: web/app/creation-rules/CreationRuleDialog.tsx
- Modify: web/app/creation-rules/CreationRulesPanel.tsx
- Modify: web/app/creation-rules/CreationRulesClient.test.tsx
- Modify: web/lib/api/creation-rules.ts

**Interfaces:**
- Consumes: builder fields represented by DailyCreationRuleInput.
- Produces: buildCreationRulePrompt(input: CreationRulePromptBuilder) -> string and a submitted prompt never regenerated implicitly.

- [ ] **Step 1: Write failing generator and dialog tests**

~~~typescript
it('generates an editable X draft prompt with exact tool arguments', () => {
  const prompt = buildCreationRulePrompt({
    assetType: 'article',
    directories: ['搞钱副业', 'AI 产品'],
    targetCount: 3,
    lookbackDays: 14,
    accountId: null,
    skillMode: 'auto',
    skillName: null,
    instructions: '每句话单独成段',
  })

  expect(prompt).toContain('搞钱副业、AI 产品')
  expect(prompt).toContain('创作 3 条中文 X 短帖')
  expect(prompt).toContain('最近 14 天')
  expect(prompt).toContain('save_draft')
  expect(prompt).toContain('draft_type="x"')
  expect(prompt).toContain('每句话单独成段')
  expect(prompt).not.toContain('save_daily_creation_outputs')
})
~~~

Add dialog tests proving manual prompt submission works without a directory, the generator fills the editor, builder edits do not alter prompt, and regeneration confirms before replacement.

- [ ] **Step 2: Run tests and verify RED**

~~~bash
pnpm test -- app/creation-rules/creation-rule-prompt.test.ts app/creation-rules/CreationRulesClient.test.tsx
~~~

Run from web. Expected: helper and prompt editor are missing.

- [ ] **Step 3: Implement the pure generator**

Use the same semantics as the backend legacy converter. The save instruction is:

~~~typescript
'每条完成后调用 save_draft 保存到草稿箱，参数必须使用 status="drafting"、draft_type="x"。'
~~~

Do not include save_daily_creation_outputs anywhere in newly generated text.

- [ ] **Step 4: Refactor the dialog**

Make name, schedule, and Agent prompt primary. Put existing material, Skill, count, lookback, account, and additional instruction controls inside an expandable 快速生成提示词 section.

Submission validation is:

~~~typescript
if (!value.name.trim()) return setError('请输入任务名称')
if (!value.prompt.trim()) return setError('请输入 Agent 提示词')
if (value.execution_mode === 'once' && !value.scheduled_date) {
  return setError('请选择执行日期')
}
~~~

Builder field changes never mutate prompt. A non-empty prompt requires window.confirm("重新生成会替换当前提示词，是否继续？") before replacement.

- [ ] **Step 5: Update API types and task cards**

Add prompt: string to rule and input types. Keep builder fields for panel restoration. Task cards show a two-line prompt summary, schedule, last run, next run, and latest status; remove directory/count/dedup/Skill from the primary summary.

- [ ] **Step 6: Run tests and verify GREEN**

Run the Task 5 command again. Expected: zero failures.

- [ ] **Step 7: Commit Task 5**

~~~bash
git add web/app/creation-rules/creation-rule-prompt.ts web/app/creation-rules/creation-rule-prompt.test.ts web/app/creation-rules/CreationRuleDialog.tsx web/app/creation-rules/CreationRulesPanel.tsx web/app/creation-rules/CreationRulesClient.test.tsx web/lib/api/creation-rules.ts
git commit -m "feat: add prompt-first scheduled task editor"
~~~

---

### Task 6: Cross-Layer Regression and Production Verification

**Files:**
- Modify only the owning Task files if a command exposes a regression.

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: verified backend, worker, frontend, and build behavior.

- [ ] **Step 1: Run the focused backend suite**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_database_init_postgres.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_daily_creation_scheduler.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_service.py backend/tests/test_content_jobs.py backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_agent_execution_service.py backend/tests/test_agent_executions_router.py backend/tests/test_jobs_router.py backend/tests/test_drafts_router.py -q
~~~

Expected: zero failures. PostgreSQL availability failures must be reported separately and never described as passing.

- [ ] **Step 2: Run the focused frontend and worker suite**

~~~bash
pnpm test -- app/creation-rules lib/ai/daily-creation-agent-job.test.ts lib/ai/daily-creation-agent-integration.test.ts lib/ai/agent-runtime.test.ts scripts/content-worker.test.ts
~~~

Run from web. Expected: zero failures.

- [ ] **Step 3: Verify retired runtime references**

~~~bash
rg -n "save_daily_creation_outputs" backend web/lib web/app web/scripts
~~~

Expected: no production runtime reference. One explicit historical compatibility fixture is allowed.

- [ ] **Step 4: Run static and production checks**

~~~bash
pnpm lint
pnpm build
~~~

Run from web. Expected: both commands exit 0. If sandboxing blocks a required operation, rerun with approval and report the exact limitation.

- [ ] **Step 5: Inspect the final diff**

~~~bash
git diff --check
git status --short
git diff --stat
~~~

Confirm historical batch tables remain, new runs use prompt snapshots, and unrelated dirty-worktree files were not staged.

- [ ] **Step 6: Resolve verification failures through the owning task**

For each failure, return to the Task that owns the affected file, write or tighten the failing regression test, apply the minimal fix, rerun that Task's focused command, and amend only that Task's commit. If no failures occur, make no verification-only commit.

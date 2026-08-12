# Agent Tool Audit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require directory evidence for creative-asset candidate calls and prevent recovered read-only tool failures from masking unresolved Agent failures.

**Architecture:** Tighten only the MCP-facing function signature while preserving the shared service's legacy `directory` compatibility. Add a pure TypeScript audit selector used by the daily-creation job after runtime completion; persisted audit events and tool-call transitions remain unchanged.

**Tech Stack:** Python 3.11, FastMCP, pytest, TypeScript, Vitest.

## Global Constraints

- `directories` is required in the Agent-facing MCP schema and must contain at least one valid directory.
- Empty or oversized directory lists remain invalid; never query all creative assets as a fallback.
- The Python service retains compatibility with legacy `directory` callers.
- Only `failed`, non-side-effecting calls can recover, and only when a later same-name call succeeds.
- `uncertain` and side-effecting failures never recover.
- Persisted audit records are unchanged.
- Do not modify `generateImage` or its 404 behavior.

---

### Task 1: Require Candidate Directories in the MCP Schema

**Files:**
- Modify: `backend/mcp_server.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`

**Interfaces:**
- Consumes: `daily_creation_service.list_creative_asset_candidates(..., directories, directory, query, limit)` with legacy support intact.
- Produces: MCP tool schema where `directories` is in `inputSchema.required` and the callable accepts `directories: list[str]`.

- [ ] **Step 1: Write the failing schema test**

Add a test that loads MCP tools and checks the exact candidate schema:

```python
def test_candidate_tool_requires_directories(env):
    import mcp_server

    tools = {tool.name: tool for tool in run(mcp_server.mcp.list_tools())}
    schema = tools["list_creative_asset_candidates"].inputSchema

    assert "directories" in schema["required"]
```

Keep the existing functional test using legacy `directory="产品实验"` so service compatibility remains covered independently.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_mcp_daily_creation_tools.py::test_candidate_tool_requires_directories -q
```

Expected: FAIL because `directories` currently has a default and is optional in the generated schema.

- [ ] **Step 3: Tighten the MCP function signature**

Change the MCP wrapper to require `directories` while leaving the service unchanged:

```python
@mcp.tool()
async def list_creative_asset_candidates(
    asset_type: str,
    directories: list[str],
    query: str = "",
    limit: int = 50,
) -> list[dict]:
    """List compact candidates from one or more task-specified asset directories."""
    async with SessionLocal() as db:
        return await list_candidates(
            db,
            asset_type=asset_type,
            directories=directories,
            query=query,
            limit=limit,
        )
```

Update MCP tests to call the wrapper with `directories=["产品实验"]`. Keep service-level legacy `directory` tests unchanged.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_daily_creation_service.py -q
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the schema slice**

```bash
git add backend/mcp_server.py backend/tests/test_mcp_daily_creation_tools.py
git commit -m "fix: require directories for asset candidates"
```

### Task 2: Ignore Recovered Read-Only Audit Failures

**Files:**
- Modify: `wemedia-studio/lib/ai/daily-creation-agent-job.ts`
- Modify: `wemedia-studio/lib/ai/daily-creation-agent-job.test.ts`

**Interfaces:**
- Consumes: ordered `AgentToolAudit[]` with `toolName`, `status`, and `sideEffecting`.
- Produces: exported pure function `firstBlockingToolAudit(audits: AgentToolAudit[]): AgentToolAudit | undefined` used by `runDailyCreationAgentJob`.

- [ ] **Step 1: Write failing audit-selection tests**

Add focused tests for the pure selector:

```ts
it('ignores a read-only failure recovered by a later same-tool success', () => {
  const failed = audit('list_creative_asset_candidates', 'failed', false)
  const recovered = audit('list_creative_asset_candidates', 'succeeded', false)
  const unresolved = audit('generateImage', 'failed', false)

  expect(firstBlockingToolAudit([failed, recovered, unresolved])).toBe(unresolved)
})
```

Add separate cases asserting:

```ts
expect(firstBlockingToolAudit([audit('read', 'failed', false)]))
  .toMatchObject({ toolName: 'read', status: 'failed' })
expect(firstBlockingToolAudit([
  audit('write', 'failed', true), audit('write', 'succeeded', true),
])).toMatchObject({ toolName: 'write', status: 'failed' })
expect(firstBlockingToolAudit([
  audit('read', 'uncertain', false), audit('read', 'succeeded', false),
])).toMatchObject({ toolName: 'read', status: 'uncertain' })
```

Also add a job-level test proving a failed candidate call followed by a successful candidate call and failed `generateImage` throws `Agent tool audit is failed: generateImage`.

- [ ] **Step 2: Run focused frontend test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts
```

Expected: FAIL because the selector does not exist and the job currently uses `audits.find(...)`.

- [ ] **Step 3: Implement the pure blocking selector**

Implement ordered look-ahead without mutating audits:

```ts
export function firstBlockingToolAudit(audits: AgentToolAudit[]) {
  return audits.find((audit, index) => {
    if (audit.status === 'uncertain') return true
    if (audit.status !== 'failed') return false
    if (audit.sideEffecting) return true
    return !audits.slice(index + 1).some(later => (
      later.toolName === audit.toolName && later.status === 'succeeded'
    ))
  })
}
```

Replace the current `audits.find(...)` final gate with this function. Do not change `onToolAudit`, persistence calls, checkpoint payloads, or success counts.

- [ ] **Step 4: Run focused and related tests**

Run:

```bash
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/agent-runtime.test.ts lib/ai/agent-tool-policy.test.ts lib/ai/agent-execution-client.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the audit slice**

```bash
git add wemedia-studio/lib/ai/daily-creation-agent-job.ts wemedia-studio/lib/ai/daily-creation-agent-job.test.ts
git commit -m "fix: recover read-only agent tool audits"
```

### Task 3: Cross-Layer Verification

**Files:**
- Verify only; no planned production modifications.

**Interfaces:**
- Consumes: required MCP directory schema and the daily-job blocking selector.
- Produces: evidence that the two layers work together without changing generation behavior.

- [ ] **Step 1: Run all focused regression suites**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_mcp_daily_creation_tools.py backend/tests/test_daily_creation_service.py backend/tests/test_agent_execution_service.py -q
cd wemedia-studio
pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts lib/ai/agent-runtime.test.ts lib/ai/agent-tool-policy.test.ts lib/ai/agent-execution-client.test.ts
pnpm exec eslint lib/ai/daily-creation-agent-job.ts lib/ai/daily-creation-agent-job.test.ts
```

Expected: all tests PASS and ESLint exits 0.

- [ ] **Step 2: Verify repository state**

Run:

```bash
git diff --check
git status --short
git log -4 --oneline
```

Expected: no uncommitted changes and both implementation commits are present.

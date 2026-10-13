# Agent Topic Novelty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Agent-created drafts from repeating the same topic and core claim inside a global, time-limited history while leaving all manual and backend draft creation unchanged.

**Architecture:** Add an Agent-only topic-claim ledger and semantic novelty service in the backend. The MCP `save_draft` tool delegates to a dedicated atomic save service, while existing REST draft paths remain policy-neutral; trusted Chat or scheduled identity travels through MCP transport headers.

**Tech Stack:** FastAPI, SQLAlchemy async/PostgreSQL, FastMCP, existing `llm._call`, Next.js/TypeScript AI SDK runtime, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-08-27-agent-topic-novelty-design.md`

## Global Constraints

- Apply novelty only to the Agent-visible `save_draft` MCP tool.
- Keep manual, imported, edited, and internal backend drafts unchanged.
- Use one global topic history; do not add platform/account/rule scope.
- Use 14 days for Chat and the existing `lookback_days` for scheduled creation.
- Do not reserve topics before draft save.
- Treat model failure or invalid output as `uncertain`, never `novel`.
- Let Chat override only through a one-time challenge followed by existing interactive tool approval; never let a scheduled Agent override.
- Commit the final novelty check, draft insert, and claim insert atomically behind a PostgreSQL advisory transaction lock.
- Do not introduce a vector database.
- Run backend tests with `/home/violet/miniconda3/envs/wems/bin/python -m pytest`.
- Run exact frontend tests from `web` with `pnpm exec vitest run`.
- Implement in an isolated feature worktree, not directly on `develop`.

## File Structure

- Create `backend/agent_topic_novelty.py`: normalization, retrieval, model verdicts, overrides, and Agent-only save.
- Modify `backend/models.py`: topic-claim and override persistence; existing `Base.metadata.create_all` creates both tables.
- Modify `backend/mcp_server.py`: advisory tool and dedicated Agent save delegation.
- Modify `backend/routers/drafts.py`: release claims when linked drafts are deleted.
- Modify `web/lib/ai/global-chat-tools.ts`, `agent-runtime.ts`, and Chat route: trusted MCP identity headers.
- Modify `web/lib/ai/daily-creation-agent-job.ts` and `backend/daily_creation_prompt.py`: bounded scheduled topic changes.
- Add focused pytest/Vitest coverage beside each changed boundary.

---

### Task 1: Agent Topic Ledger and Migration

**Files:**
- Modify: `backend/models.py`
- Create: `backend/tests/test_agent_topic_novelty.py`
- Modify: `backend/tests/test_database_init_postgres.py`

**Interfaces:**
- Produces: `AgentTopicClaim` and `AgentNoveltyOverride` SQLAlchemy models.
- Produces: one active claim per Agent-created draft and one-time override rows keyed by token digest.

- [ ] **Step 1: Write failing schema tests**

Add this persistence shape to `test_agent_topic_novelty.py`:

```python
async def test_agent_topic_claim_defaults_and_override_uniqueness(db):
    from models import AgentNoveltyOverride, AgentTopicClaim, ArticleDraft

    draft = ArticleDraft(topic_id="agent", title="标题", content="正文")
    db.add(draft)
    await db.flush()
    db.add(AgentTopicClaim(
        draft_id=draft.id,
        topic="Agent 工具选择",
        core_claim="严格契约比扩大工具列表更重要",
        key_facts=["schema 可限制参数"],
        decision="novel",
        reason="窗口内无冲突",
        window_days=14,
        agent_mode="chat",
        agent_session_id=12,
    ))
    db.add(AgentNoveltyOverride(
        token_digest="a" * 64,
        candidate_digest="b" * 64,
        conflict_claim_ids=[1],
        agent_session_id=12,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    ))
    await db.commit()
```

Extend `test_database_init_postgres.py` to require both tables, the unique
`draft_id`, unique `token_digest`, and the active-claim/expiry indexes.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_database_init_postgres.py -q
```

Expected: FAIL because both models are absent.

- [ ] **Step 3: Implement the exact models**

```python
class AgentTopicClaim(Base):
    __tablename__ = "agent_topic_claims"
    __table_args__ = (
        UniqueConstraint("draft_id", name="uq_agent_topic_claim_draft"),
        Index("ix_agent_topic_claim_active", "released_at", "claimed_at"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    topic: Mapped[str] = mapped_column(Text, nullable=False)
    core_claim: Mapped[str] = mapped_column(Text, nullable=False)
    key_facts: Mapped[list] = mapped_column(JSON, default=list)
    event_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    novelty_basis: Mapped[str] = mapped_column(Text, default="")
    source_item_ids: Mapped[list] = mapped_column(JSON, default=list)
    decision: Mapped[str] = mapped_column(String, nullable=False)
    conflict_claim_ids: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str] = mapped_column(Text, default="")
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=14)
    agent_mode: Mapped[str] = mapped_column(String, nullable=False)
    agent_session_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    daily_creation_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    override_token_digest: Mapped[str | None] = mapped_column(String, nullable=True, unique=True)
    claimed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentNoveltyOverride(Base):
    __tablename__ = "agent_novelty_overrides"
    __table_args__ = (Index("ix_agent_novelty_override_expiry", "expires_at"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_digest: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    candidate_digest: Mapped[str] = mapped_column(String, nullable=False)
    conflict_claim_ids: Mapped[list] = mapped_column(JSON, default=list)
    agent_session_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

Use the existing `init_db()` call to `Base.metadata.create_all`; no raw DDL or
column migration is needed because both tables are new. Verify repeated
`init_db()` calls preserve existing rows and do not recreate indexes.

- [ ] **Step 4: Run tests and commit**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_database_init_postgres.py -q
git add backend/models.py \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_database_init_postgres.py
git commit -m "feat: add agent topic novelty ledger"
```

Expected: PASS.

---

### Task 2: Semantic Novelty Service

**Files:**
- Create: `backend/agent_topic_novelty.py`
- Modify: `backend/tests/test_agent_topic_novelty.py`

**Interfaces:**
- Produces: `AgentIdentity`, `NoveltyCandidate`, and `NoveltyDecision` dataclasses.
- Produces: `check_content_novelty(session, *, candidate, window_days, judge, now=None)`.
- Consumes: active `AgentTopicClaim` rows from Task 1.

- [ ] **Step 1: Write failing policy tests**

Use a table-driven test with concrete model verdicts:

```python
@pytest.mark.parametrize(("verdict", "expected"), [
    ({"decision": "duplicate", "reason": "same claim",
      "novelty_basis": "", "suggested_action": "change_topic"}, "duplicate"),
    ({"decision": "novel", "reason": "opposite conclusion",
      "novelty_basis": "", "suggested_action": "continue"}, "novel"),
    ({"decision": "new_development", "reason": "later release",
      "novelty_basis": "a new version shipped after the prior draft",
      "suggested_action": "continue"}, "new_development"),
])
async def test_model_verdicts_are_normalized(db, verdict, expected):
    claim = AgentTopicClaim(
        draft_id=1, topic="Agent 工具选择", core_claim="契约优先",
        key_facts=[], decision="novel", reason="seed", window_days=14,
        agent_mode="chat",
    )
    db.add(claim)
    await db.commit()

    async def judge(candidate, conflicts):
        assert conflicts[0]["id"] == claim.id
        return verdict

    result = await check_content_novelty(
        db,
        candidate=NoveltyCandidate("Agent 工具选择", "契约优先"),
        window_days=14,
        judge=judge,
    )
    assert result.decision == expected
    assert result.reason == verdict["reason"]
```

Add separate concrete assertions that released and 15-day-old claims do not
invoke the judge, invalid JSON and judge exceptions return `uncertain`, and a
shortlist contains at most ten rows ordered by similarity then recency.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py -q
```

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement bounded types and shortlist retrieval**

```python
@dataclass(frozen=True)
class AgentIdentity:
    mode: Literal["chat", "scheduled"]
    session_id: int | None = None
    daily_creation_run_id: int | None = None


@dataclass(frozen=True)
class NoveltyCandidate:
    topic: str
    core_claim: str
    key_facts: Sequence[str] = ()
    event_time: datetime | None = None
    source_item_ids: Sequence[int] = ()


@dataclass(frozen=True)
class NoveltyDecision:
    decision: Literal["novel", "duplicate", "new_development", "uncertain"]
    conflicts: Sequence[dict]
    reason: str
    novelty_basis: str
    suggested_action: Literal["continue", "change_topic", "ask_user"]
```

Bound topic/core claim to 1,000 characters, facts to 20 entries of 500
characters, source IDs to 100 unique positive integers, and window to 1..90.
Query active rows inside the window, newest first, capped at 500. Rank prepared
`topic + core_claim` strings with `text_dedupe.similarity`; send at most 10
positive-score rows to the judge. Return `novel` without a model call when the
shortlist is empty.

- [ ] **Step 4: Implement the model judge and strict parser**

```python
async def judge_novelty_with_model(candidate, conflicts):
    raw = await llm._call(
        build_novelty_prompt(candidate, conflicts), max_tokens=1200,
    )
    return parse_novelty_verdict(raw)
```

Accept only the four decision values, require a non-empty reason, and require
`novelty_basis` for `new_development`. Any exception or malformed object
returns `uncertain` with `suggested_action="ask_user"`.

- [ ] **Step 5: Run tests and commit**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py -q
git add backend/agent_topic_novelty.py backend/tests/test_agent_topic_novelty.py
git commit -m "feat: judge agent topic novelty"
```

Expected: PASS.

---

### Task 3: Trusted Agent Identity and Advisory Tool

**Files:**
- Modify: `web/lib/ai/global-chat-tools.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/lib/ai/global-chat-tools.test.ts`
- Modify: `web/lib/ai/agent-runtime.test.ts`
- Modify: `web/app/api/chat/route.test.ts`
- Modify: `backend/mcp_server.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`

**Interfaces:**
- Produces: trusted `X-Agent-Mode`, `X-Agent-Session-Id`, and existing scheduled-run headers.
- Produces: read-only `check_content_novelty` MCP tool.
- Consumes: service from Task 2.

- [ ] **Step 1: Write failing identity propagation tests**

```ts
expect(createMCPClient).toHaveBeenLastCalledWith({ transport: expect.objectContaining({
  headers: { 'X-Agent-Mode': 'chat', 'X-Agent-Session-Id': '92' },
}) })
expect(createMCPClient).toHaveBeenLastCalledWith({ transport: expect.objectContaining({
  headers: { 'X-Agent-Mode': 'scheduled', 'X-Daily-Creation-Run-Id': '83' },
}) })
```

Assert `body.sessionId` reaches `openAgentRuntime`, then `openTools`, and never
enters model messages/provider input.

- [ ] **Step 2: Write failing MCP contract tests**

Require the advisory tool to be read-only with `window_days` 1..90, at most 20
facts, and at most 100 source IDs. Stub the judge and assert the canonical
decision result.

- [ ] **Step 3: Run tests and verify RED**

```bash
cd web && pnpm exec vitest run \
  lib/ai/global-chat-tools.test.ts lib/ai/agent-runtime.test.ts \
  app/api/chat/route.test.ts
cd .. && /home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_daily_creation_tools.py -q
```

Expected: FAIL for missing headers and tool.

- [ ] **Step 4: Propagate trusted transport identity**

Add `sessionId?: number` to `OpenAgentRuntimeOptions`, pass it into
`toolOptions`, and build headers in `openGlobalAgentTools`:

```ts
const headers = dailyCreationRunId === undefined
  ? { 'X-Agent-Mode': 'chat', 'X-Agent-Session-Id': String(sessionId) }
  : { 'X-Agent-Mode': 'scheduled', 'X-Daily-Creation-Run-Id': String(dailyCreationRunId) }
```

Reject invalid Chat identity and never accept mode from tool arguments. Pass
`body.sessionId` from the Chat route.

- [ ] **Step 5: Register `check_content_novelty`**

```python
async def check_content_novelty(
    topic: str,
    core_claim: str,
    key_facts: Annotated[list[str], Field(max_length=20)] | None = None,
    event_time: datetime | None = None,
    source_item_ids: Annotated[list[int], Field(max_length=100)] | None = None,
    window_days: Annotated[int, Field(ge=1, le=90)] = 14,
) -> dict:
    candidate = NoveltyCandidate(
        topic=topic, core_claim=core_claim,
        key_facts=tuple(key_facts or ()),
        event_time=event_time,
        source_item_ids=tuple(source_item_ids or ()),
    )
    async with SessionLocal() as db:
        return asdict(await check_novelty(db, candidate=candidate,
            window_days=window_days, judge=judge_novelty_with_model))
```

Decorate it as a read-only, idempotent, parallel-safe `drafts` tool.

- [ ] **Step 6: Run tests and commit**

Run Step 3 commands. Expected: PASS.

```bash
git add web/lib/ai/global-chat-tools.ts web/lib/ai/agent-runtime.ts \
  web/app/api/chat/route.ts web/lib/ai/global-chat-tools.test.ts \
  web/lib/ai/agent-runtime.test.ts web/app/api/chat/route.test.ts \
  backend/mcp_server.py backend/tests/test_mcp_daily_creation_tools.py
git commit -m "feat: expose agent topic novelty checks"
```

---

### Task 4: Dedicated Atomic Agent Draft Save and Chat Override

**Files:**
- Modify: `backend/agent_topic_novelty.py`
- Modify: `backend/mcp_server.py`
- Modify: `backend/tests/test_agent_topic_novelty.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`

**Interfaces:**
- Produces: `save_agent_draft_with_novelty_check(session, *, title, content, topic_id, status, pipeline_task_id, draft_type, identity, window_days, override_token=None)`.
- Produces: `{saved: true, id, novelty}` or `{saved: false, novelty, override_token?}`.
- Consumes: identity headers from Task 3 and persistence/service from Tasks 1-2.

- [ ] **Step 1: Write failing save-boundary tests**

Write the primary atomic-save test in this form:

```python
def fake_candidate(topic: str, core_claim: str):
    async def extract(title: str, content: str) -> NoveltyCandidate:
        assert title and content
        return NoveltyCandidate(topic=topic, core_claim=core_claim)
    return extract


def fake_verdict(decision: str):
    async def judge(candidate, conflicts):
        return {
            "decision": decision,
            "reason": "test verdict",
            "novelty_basis": "",
            "suggested_action": (
                "continue" if decision == "novel" else "change_topic"
            ),
        }
    return judge


async def test_agent_save_persists_draft_and_claim_atomically(db):
    result = await save_agent_draft_with_novelty_check(
        db,
        title="工具契约",
        content="工具契约决定 Agent 能否稳定选择工具。",
        topic_id="agent",
        status="drafting",
        pipeline_task_id=None,
        draft_type="article",
        identity=AgentIdentity(mode="chat", session_id=92),
        window_days=14,
        extract_candidate=fake_candidate("Agent 工具选择", "契约决定稳定性"),
        judge=fake_verdict("novel"),
    )
    assert result["saved"] is True
    assert result["id"] > 0
    claim = await db.scalar(select(AgentTopicClaim).where(
        AgentTopicClaim.draft_id == result["id"]
    ))
    assert claim is not None
    assert claim.agent_session_id == 92
```

Add concrete variants asserting: duplicate Chat returns no `id` and one
challenge; a matching retry consumes it; wrong session/candidate/conflict set,
expiry, and replay all fail; scheduled mode rejects tokens and receives none;
an injected claim flush failure leaves zero drafts; two PostgreSQL sessions
racing on the same candidate yield exactly one `saved:true` result.

Add an MCP regression showing direct backend `ArticleDraft` creation remains
unrestricted while `mcp_server.save_draft` returns `saved: false` for an Agent
duplicate.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_mcp_daily_creation_tools.py -q
```

Expected: FAIL because the dedicated save and override flow are absent.

- [ ] **Step 3: Extract the authoritative candidate from actual content**

Before locking, call one bounded model prompt that extracts the canonical
candidate from `title + content`. Invalid extraction produces `uncertain`.
Use stable digests:

```python
candidate_digest = hashlib.sha256(
    json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()
).hexdigest()
token_digest = hashlib.sha256(override_token.encode()).hexdigest()
```

Persist only the digest in novelty business tables. The short-lived plaintext
token remains in the Agent tool result because the approved retry must be able
to recover it; existing Agent-log redaction and retention rules apply to that
tool result.

- [ ] **Step 4: Implement the PostgreSQL critical section**

Begin one transaction and acquire a fixed advisory transaction lock:

```python
await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {
    "key": AGENT_TOPIC_NOVELTY_LOCK_KEY,
})
```

Inside the lock: re-read history, decide novelty, validate/consume any
override, insert `ArticleDraft`, update `PipelineTask` exactly as current
`save_draft` does, flush, insert `AgentTopicClaim`, and commit once. Inject a
no-op lock only for SQLite unit tests; prove cross-process serialization with
the PostgreSQL fixture.

- [ ] **Step 5: Implement one-time Chat challenges**

On Chat `duplicate` or `uncertain`, insert a ten-minute
`AgentNoveltyOverride`, return its plaintext random token once, and return no
draft ID. Bind the challenge to session ID, candidate digest, and exact
conflict IDs. On retry require matching bindings, unexpired and unconsumed
state, then consume it and store its digest on the resulting claim. Scheduled
identity rejects an override and never receives a challenge.

- [ ] **Step 6: Delegate MCP `save_draft` to the dedicated service**

Add `ctx: Context` and optional `novelty_override_token`. Read
mode/session/run from headers only. For a scheduled run load
`DailyCreationRun.rule_snapshot.lookback_days`; otherwise use 14. The
authoritative save tool exposes no model-controlled window parameter.

Successful output preserves existing evidence fields:

```json
{
  "saved": true,
  "id": 123,
  "title": "标题",
  "status": "drafting",
  "draft_type": "x",
  "created_at": "2026-08-27T12:00:00Z",
  "novelty": {"decision": "novel"}
}
```

Conflict output has `saved: false` and no `id`, preventing existing completion
parsers from treating it as a persisted draft.

- [ ] **Step 7: Run tests and commit**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_mcp_daily_creation_tools.py -q
git add backend/agent_topic_novelty.py backend/mcp_server.py \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_mcp_daily_creation_tools.py
git commit -m "feat: enforce novelty on agent draft saves"
```

Expected: PASS.

---

### Task 5: Draft Deletion Lifecycle

**Files:**
- Modify: `backend/routers/drafts.py`
- Modify: `backend/tests/test_drafts_router.py`

**Interfaces:**
- Consumes: `AgentTopicClaim` from Task 1.
- Produces: deletion releases an existing claim without changing normal draft creation/editing.

- [ ] **Step 1: Write failing lifecycle tests**

Use the existing router fixture to create one normal draft and one draft with a
claim, then make these exact assertions:

```python
response = client.delete(f"/api/drafts/{agent_draft_id}")
assert response.status_code == 204
released = run(read_claim(agent_draft_id))
assert released is not None
assert released.released_at is not None

response = client.patch(f"/api/drafts/{normal_draft_id}", json={
    "title": "人工修改后的主题",
})
assert response.status_code == 200
assert run(read_claim(normal_draft_id)) is None
```

Also edit the Agent-created draft before deletion and assert its original
`topic`, `core_claim`, and `claimed_at` are unchanged.

Assert the claim row remains for audit with `released_at` set, while the draft
is deleted. Normal draft creation/editing must never create a claim.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_drafts_router.py -q
```

Expected: FAIL because release is absent.

- [ ] **Step 3: Add the narrow deletion hook**

```python
await db.execute(
    update(AgentTopicClaim)
    .where(
        AgentTopicClaim.draft_id == draft_id,
        AgentTopicClaim.released_at.is_(None),
    )
    .values(released_at=datetime.now(timezone.utc))
)
```

Do not call the semantic service and do not modify create/update endpoints.

- [ ] **Step 4: Run tests and commit**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_drafts_router.py -q
git add backend/routers/drafts.py backend/tests/test_drafts_router.py
git commit -m "feat: release agent topic claims on deletion"
```

Expected: PASS.

---

### Task 6: Scheduled Agent Topic Changes and Exhaustion

**Files:**
- Modify: `backend/daily_creation_prompt.py`
- Modify: `backend/tests/test_daily_creation_rule_schema.py`
- Modify: `web/lib/ai/daily-creation-agent-job.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.test.ts`

**Interfaces:**
- Consumes: structured conflict output from Task 4.
- Produces: scheduled instructions and a hard limit of three save-time topic conflicts.

- [ ] **Step 1: Write failing prompt and job tests**

Require the prompt to name `check_content_novelty`, global topic/core-claim
comparison, and automatic topic changes. Simulate three audits shaped as:

```ts
{
  toolName: 'save_draft',
  status: 'succeeded',
  output: {
    saved: false,
    novelty: { decision: 'duplicate', suggested_action: 'change_topic' },
  },
}
```

Assert the first two remain model evidence, the third fails with `no
sufficiently novel topic was available in the configured time window`, and no
completion evidence is recorded.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_daily_creation_rule_schema.py -q
cd web && pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts
```

Expected: FAIL for missing instructions/counter.

- [ ] **Step 3: Update the scheduled objective**

Add these semantics while preserving asset-usage instructions:

```text
先提出多个候选主题，并用 check_content_novelty 检查主题和核心观点。
duplicate 或 uncertain 必须换题。save_draft 返回 saved=false 时根据冲突证据换题后重写；定时任务不得使用 novelty_override_token。
```

- [ ] **Step 4: Count only structured save conflicts**

```ts
export function isNoveltySaveConflict(audit: AgentToolAudit) {
  const output = audit.output as Record<string, unknown> | undefined
  const novelty = output?.novelty as Record<string, unknown> | undefined
  return audit.toolName === 'save_draft'
    && audit.status === 'succeeded'
    && output?.saved === false
    && ['duplicate', 'uncertain'].includes(String(novelty?.decision))
}
```

Count final audits in the job boundary. Throw the exact non-retryable domain
error after the third. Do not count advisory checks or transport failures.

- [ ] **Step 5: Run tests and commit**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_daily_creation_rule_schema.py -q
cd web && pnpm exec vitest run lib/ai/daily-creation-agent-job.test.ts
cd .. && git add backend/daily_creation_prompt.py \
  backend/tests/test_daily_creation_rule_schema.py \
  web/lib/ai/daily-creation-agent-job.ts \
  web/lib/ai/daily-creation-agent-job.test.ts
git commit -m "feat: bound scheduled agent novelty retries"
```

Expected: PASS.

---

### Task 7: Integrated Contracts and Verification

**Files:**
- Modify: `backend/tests/test_mcp_tool_contracts.py`
- Modify: `web/lib/ai/content-response-output-job.test.ts`
- Modify: `web/lib/ai/daily-creation-agent-integration.test.ts`

**Interfaces:**
- Verifies all interfaces from Tasks 1-6 together.

- [ ] **Step 1: Add completion and tool-contract tests**

Require `check_content_novelty` to be read-only and `save_draft` to remain a
serialized, claim-backed write. Completion accepts only `saved === true` plus
a positive `id`; `saved:false` never counts as saved-draft evidence.

- [ ] **Step 2: Add one integrated scheduled scenario**

Exercise a first conflicting candidate followed by a second saved candidate.
Assert goal completion references only the real saved draft ID and the topic
claim points to that draft. Keep provider/MCP dependencies fake except the
actual runtime/tool-policy wiring.

- [ ] **Step 3: Run focused backend verification**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_agent_topic_novelty.py \
  backend/tests/test_mcp_daily_creation_tools.py \
  backend/tests/test_mcp_tool_contracts.py \
  backend/tests/test_drafts_router.py \
  backend/tests/test_database_init_postgres.py \
  backend/tests/test_daily_creation_rule_schema.py -q
```

Expected: PASS.

- [ ] **Step 4: Run focused frontend verification**

```bash
cd web && pnpm exec vitest run \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/agent-runtime.test.ts \
  app/api/chat/route.test.ts \
  lib/ai/daily-creation-agent-job.test.ts \
  lib/ai/daily-creation-agent-integration.test.ts \
  lib/ai/content-response-output-job.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run changed-surface static checks**

```bash
cd web && pnpm exec eslint \
  lib/ai/global-chat-tools.ts lib/ai/agent-runtime.ts \
  lib/ai/daily-creation-agent-job.ts app/api/chat/route.ts
cd .. && git diff --check && git status --short
```

Expected: ESLint and `git diff --check` pass; status contains only intended
feature changes. Do not claim a repository-wide typecheck is green unless it
is run and unrelated baseline failures are reported separately.

- [ ] **Step 6: Commit regression coverage**

```bash
git add backend/tests/test_mcp_tool_contracts.py \
  web/lib/ai/content-response-output-job.test.ts \
  web/lib/ai/daily-creation-agent-integration.test.ts
git commit -m "test: cover agent topic novelty workflow"
```

- [ ] **Step 7: Review and integrate**

Request independent review of the feature diff, fix verified findings, rerun
Steps 3-5, then use `superpowers:finishing-a-development-branch`. Merge back to
local `develop` only when the user explicitly requests testing integration.

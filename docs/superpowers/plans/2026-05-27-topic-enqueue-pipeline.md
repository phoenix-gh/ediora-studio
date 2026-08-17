# Topic Enqueue Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When selected hot topics are enqueued, automatically create the full Hermes kanban task chain (editor→writer→illustrator for `long`, writer-only for `short`/`story`/`share`) with proper PipelineTask DB records and parent-child linking.

**Architecture:** Two new pipeline variants (`topic_long`, `topic_short`) are added to `pipeline_template.py` with bodies tailored for topic-origin inputs (angle + source X posts instead of raw article material). The `/topic-generator/enqueue` backend endpoint is refactored to require `account_id`, load the account profile, select the right pipeline, and create the linked task chain. The frontend locks the enqueue button until an account is selected and shows a "查看看板" action on success.

**Tech Stack:** FastAPI, SQLAlchemy async, Hermes kanban CLI (via `HermesKanbanClient`), Next.js 16, TypeScript, sonner toasts

---

## File Map

| File | Change |
|------|--------|
| `backend/pipeline_template.py` | Add `TOPIC_LONG_PIPELINE`, `TOPIC_SHORT_PIPELINE`, helper `_topic_short_type_requirement`; register both in `PIPELINES` |
| `backend/routers/topic_generator.py` | `EnqueueRequest.account_id` required; new enqueue logic using pipelines + PipelineTask; `EnqueueResponse` adds `pipeline_task_ids` |
| `backend/tests/test_pipeline_template_topic.py` | New — tests for the two new pipelines |
| `backend/tests/test_topic_generator.py` | Update existing `test_enqueue_topic`; add new tests for full pipeline behavior |
| `web/lib/api/topic-generator.ts` | `EnqueueRequest.account_id: string`; `EnqueueResponse` adds `pipeline_task_ids: number[]` |
| `web/app/trend-topics/TopicGeneratorClient.tsx` | Lock enqueue button when no account; success toast with "查看看板" action |

---

## Task 1: Add topic pipeline steps to `pipeline_template.py`

**Files:**
- Modify: `backend/pipeline_template.py`
- Create: `backend/tests/test_pipeline_template_topic.py`

- [ ] **Step 1.1: Write failing tests**

Create `backend/tests/test_pipeline_template_topic.py`:

```python
import pytest
from pipeline_template import get_pipeline, FULL_PIPELINE

SAMPLE_CTX = {
    "title": "AI 大模型趋势",
    "account_id": "acc_1",
    "account_profile": {
        "name": "测试号",
        "platform": "x",
        "positioning": "AI 观察",
        "audience": "技术人",
        "tone": "犀利",
        "topic_focus": ["AI"],
        "taboo": [],
        "word_range": {"min": 1500, "max": 3000},
        "image_style": "简约",
        "cover_style": {},
        "voice_samples": [],
        "style_rules": [],
    },
    "content_type": "long",
    "content_type_label": "长文",
    "word_range": "1500-3000 字",
    "angle": "GPT-4o 发布后开发者工具链的变迁",
    "source_posts_md": "- @openai: GPT-4o is here [https://x.com/1]",
    "pipeline_task_id": 42,
    "draft_id": 0,
}


def test_topic_long_has_three_steps():
    steps = get_pipeline("topic_long")
    assert len(steps) == 3
    assert [s.assignee for s in steps] == ["wms_editor", "wms_writer", "wms_illustrator"]


def test_topic_long_editor_body_contains_angle_and_source_posts():
    steps = get_pipeline("topic_long")
    body = steps[0].body(SAMPLE_CTX)
    assert "GPT-4o 发布后开发者工具链的变迁" in body
    assert "@openai" in body
    assert "wms_editor" not in body  # sanity — body is content, not metadata


def test_topic_long_editor_body_contains_word_range():
    steps = get_pipeline("topic_long")
    body = steps[0].body(SAMPLE_CTX)
    assert "1500-3000 字" in body


def test_topic_long_writer_and_illustrator_same_as_full():
    topic_steps = get_pipeline("topic_long")
    assert topic_steps[1] is FULL_PIPELINE[1]
    assert topic_steps[2] is FULL_PIPELINE[2]


def test_topic_short_has_one_writer_step():
    steps = get_pipeline("topic_short")
    assert len(steps) == 1
    assert steps[0].assignee == "wms_writer"


def test_topic_short_story_body_contains_sentence_count():
    ctx = {**SAMPLE_CTX, "content_type": "story", "content_type_label": "微故事"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "5-6 句话" in body


def test_topic_short_share_body_contains_sentence_count():
    ctx = {**SAMPLE_CTX, "content_type": "share", "content_type_label": "发现"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "3-5 句话" in body


def test_topic_short_short_body_contains_word_count():
    ctx = {**SAMPLE_CTX, "content_type": "short", "content_type_label": "短文", "word_range": "200-500 字"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "200-500 字" in body


def test_topic_short_body_contains_angle_and_pipeline_task_id():
    steps = get_pipeline("topic_short")
    body = steps[0].body(SAMPLE_CTX)
    assert "GPT-4o 发布后开发者工具链的变迁" in body
    assert "42" in body  # pipeline_task_id


def test_unknown_pipeline_raises():
    with pytest.raises(ValueError, match="unknown flow"):
        get_pipeline("nonexistent")
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest tests/test_pipeline_template_topic.py -v 2>&1 | tail -20
```

Expected: all tests FAIL with `ImportError` or `ValueError` (pipeline not yet registered).

- [ ] **Step 1.3: Add helper and TOPIC_LONG_PIPELINE to `pipeline_template.py`**

Add after `REWRITE_ONLY_PIPELINE` (before the `PIPELINES` dict), at approximately line 422:

```python
# ── topic_long：热点选题完整链路 editor → writer → illustrator ─────────────
# 与 FULL_PIPELINE 的差异：editor 接收的是 AI 给出的选题角度 + X source posts，
# 而非用户提交的原始文章 URL + 正文。writer/illustrator 步骤完全复用 FULL_PIPELINE。

def _render_source_posts_md(source_posts_md: str) -> str:
    return source_posts_md or "（无参考帖子）"


TOPIC_LONG_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="editor",
        assignee="wms_editor",
        title=lambda c: f"策划：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
content_type: {c['content_type']}

# {c['title']}

{render_profile_editor(c['account_profile'])}

## 角度（AI 给定，直接用）
{c['angle']}

## 体裁约束
**类型**: {c['content_type_label']}（{c['word_range']}）

## 热点选题来源（X 帖子）
{_render_source_posts_md(c['source_posts_md'])}

## 这棒任务（editor · 扩充锚点 + 出 brief）
角度已由选题生成器给定，**不要重新推导角度**。
你的职责是：
1. 从 source posts 和网络搜索中提取 ≥ 3 个具体锚点（数字/人名/时间/地名/引语/场景动作）
2. 按上方画像出 brief，格式：

- **core_point**（本文唯一最重要的点，一句话；writer 必须把它当主线，篇幅 ≥40%）
- **secondary_points**（次要点 ≤ 3 个，每个标注权重：keep / mention / drop_ok）
- **必须出现的事实** 3-5 条（每条带原始链接 + 一个具体细节）
- **候选锚点** ≥ 2 个（具体的、可第一人称代入的场景或动作）
- **反方/补充观点** ≥ 1 条
- **平台与字数**：{c['word_range']}
- **候选标题** ≥ 3（语气贴 tone）
- **禁区提醒**

完成时：
- `kanban_complete(summary='brief 完成: <一句话角度>', metadata={{"topic_id": ..., "brief_md": "<完整 brief markdown>", "brief_chars": N, "core_point": "<一句话>"}})`
""".strip(),
    ),
    FULL_PIPELINE[1],  # writer — same step, same ctx keys (account_id/title/account_profile/pipeline_task_id)
    FULL_PIPELINE[2],  # illustrator — same step
]


# ── topic_short：热点选题 writer 单棒（short / story / share） ──────────────
def _topic_short_type_requirement(c: RenderCtx) -> str:
    t = c['content_type']
    if t == 'story':
        return "只写 **5-6 句话**。讲一个发生在身边的真实瞬间——有细节、有情绪、让人想转发。不要超过 6 句。"
    if t == 'share':
        return "只写 **3-5 句话** + 一句「为什么值得关注」。格式参考：发现一个…支持…核心亮点是…值得关注的原因是…"
    # short
    return "**200-500 字**，X 风格，一个核心观点，语气犀利。不要分节，不要标题，直接开写。"


TOPIC_SHORT_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="writer",
        assignee="wms_writer",
        title=lambda c: f"写稿：{c['title']}",
        body=lambda c: f"""account_id: {c['account_id']}
pipeline_task_id: {c['pipeline_task_id']}

# {c['title']}

{render_profile_writer(c['account_profile'])}

## 体裁要求（硬约束）
{_topic_short_type_requirement(c)}

## 角度
{c['angle']}

## 参考帖子（X）
{_render_source_posts_md(c['source_posts_md'])}

## 工作流（硬性，省 turn）
本任务**没有 file / code_execution / terminal 工具**，全部在 message 中完成：

1. 在 message 里**一次性**写出完整文本终稿
2. `save_draft(title='<本文标题>', content='<正文>', topic_id='agent', status='drafting', pipeline_task_id={c['pipeline_task_id']})` 拿 `draft_id`
3. `kanban_complete(summary='<标题> {c['content_type_label']}完成', metadata={{"draft_id": ..., "wordcount": N}})`

目标：从写稿到 complete **≤ 2 turn**。
""".strip(),
    ),
]
```

- [ ] **Step 1.4: Register both pipelines in the `PIPELINES` dict**

Find the existing `PIPELINES` dict (currently ends at `"rewrite_only": REWRITE_ONLY_PIPELINE`) and update it:

```python
PIPELINES: dict[str, list[PipelineStep]] = {
    "full": FULL_PIPELINE,
    "cover_only": COVER_ONLY_PIPELINE,
    "rewrite_only": REWRITE_ONLY_PIPELINE,
    "topic_long": TOPIC_LONG_PIPELINE,
    "topic_short": TOPIC_SHORT_PIPELINE,
}
```

- [ ] **Step 1.5: Run tests to confirm they pass**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest tests/test_pipeline_template_topic.py -v 2>&1 | tail -20
```

Expected: all 10 tests PASS.

- [ ] **Step 1.6: Run full test suite to check for regressions**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest -v 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_pipeline_template_topic.py
git commit -m "feat(pipeline): add topic_long and topic_short pipeline variants"
```

---

## Task 2: Refactor `/topic-generator/enqueue` backend endpoint

**Files:**
- Modify: `backend/routers/topic_generator.py`
- Modify: `backend/tests/test_topic_generator.py`

- [ ] **Step 2.1: Update existing test + add new tests in `test_topic_generator.py`**

Replace the existing `test_enqueue_topic` and add new fixtures and tests. Paste this **after** the existing `test_generate_warning_when_no_posts` test, replacing only `test_enqueue_topic`:

```python
# ── helpers for enqueue tests ────────────────────────────────────────────────

ACCOUNT_ID = "acc_test_001"

def _make_client_with_account(monkeypatch, tmp_path):
    """Client fixture that seeds one PublishAccount."""
    db_file = tmp_path / "test_acc.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models as _m

    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        from database import SessionLocal
        async with SessionLocal() as db:
            db.add(_m.PublishAccount(
                id=ACCOUNT_ID,
                name="测试账号",
                platform="x",
                word_range={"min": 1500, "max": 3000},
            ))
            await db.commit()

    asyncio.new_event_loop().run_until_complete(_setup())

    import llm as llm_mod
    async def _fake_call(prompt, max_tokens=2048):
        return "[]"
    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    return TestClient(app)


def _fake_kanban(monkeypatch):
    """Patch HermesKanbanClient.create_task; returns list of call records."""
    import hermes_kanban_client as hkc
    calls = []
    _counter = {"n": 0}

    async def _fake_create(self, *, title, body, assignee, parents=None):
        _counter["n"] += 1
        calls.append({"title": title, "assignee": assignee, "parents": parents})
        return f"t_{_counter['n']:03d}"

    monkeypatch.setattr(hkc.HermesKanbanClient, "create_task", _fake_create)
    return calls


# ── tests ────────────────────────────────────────────────────────────────────

def test_enqueue_without_account_returns_400(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    payload = {
        "account_id": "",
        "topics": [{"title": "T", "angle": "A", "type": "long",
                    "source_posts": []}],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 400


def test_enqueue_long_creates_three_tasks_with_parent_chain(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "AI 大模型趋势深度报告",
            "angle": "GPT-4o 之后的工具链",
            "type": "long",
            "source_posts": [{"username": "@openai", "content": "...", "url": "https://x.com/1"}],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 1
    assert len(body["task_ids"]) == 1
    assert len(body["pipeline_task_ids"]) == 1

    # 3 kanban tasks created: editor, writer, illustrator
    assert len(calls) == 3
    assert calls[0]["assignee"] == "wms_editor"
    assert calls[1]["assignee"] == "wms_writer"
    assert calls[2]["assignee"] == "wms_illustrator"

    # parent chain: each task links to the previous
    assert calls[0]["parents"] is None
    assert calls[1]["parents"] == ["t_001"]
    assert calls[2]["parents"] == ["t_002"]


def test_enqueue_story_creates_one_writer_task(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "朋友用 AI 的那一刻",
            "angle": "身边真实瞬间",
            "type": "story",
            "source_posts": [],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    assert calls[0]["assignee"] == "wms_writer"


def test_enqueue_share_creates_one_writer_task(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "发现一个开源邮件系统",
            "angle": "Cloudflare 自托管邮件",
            "type": "share",
            "source_posts": [{"username": "@dev", "content": "cool tool", "url": "https://github.com/x"}],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    assert calls[0]["assignee"] == "wms_writer"


def test_enqueue_short_creates_one_writer_task(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [{
            "title": "X 风格短评",
            "angle": "一个核心观点",
            "type": "short",
            "source_posts": [],
        }],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    assert len(calls) == 1
    assert calls[0]["assignee"] == "wms_writer"


def test_enqueue_multiple_topics_creates_independent_chains(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    calls = _fake_kanban(monkeypatch)

    payload = {
        "account_id": ACCOUNT_ID,
        "topics": [
            {"title": "长文选题", "angle": "A", "type": "long", "source_posts": []},
            {"title": "短文选题", "angle": "B", "type": "short", "source_posts": []},
        ],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 2
    assert len(body["task_ids"]) == 2
    assert len(body["pipeline_task_ids"]) == 2
    # long creates 3 + short creates 1 = 4 total
    assert len(calls) == 4


def test_enqueue_unknown_account_returns_400(monkeypatch, tmp_path):
    c = _make_client_with_account(monkeypatch, tmp_path)
    _fake_kanban(monkeypatch)

    payload = {
        "account_id": "nonexistent_account",
        "topics": [{"title": "T", "angle": "A", "type": "long", "source_posts": []}],
    }
    r = c.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 400
```

- [ ] **Step 2.2: Run tests to confirm they all fail**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest tests/test_topic_generator.py -v 2>&1 | tail -30
```

Expected: the new tests FAIL (old `test_enqueue_topic` is now replaced; new ones fail because logic not implemented yet).

- [ ] **Step 2.3: Rewrite `EnqueueRequest`, `EnqueueResponse`, and `enqueue_topics` in `topic_generator.py`**

Replace the `EnqueueRequest`, `EnqueueResponse`, and `enqueue_topics` function (lines 61-233) with:

```python
_WORD_RANGE: dict[str, str] = {
    "long":  "1500-3000 字",
    "short": "200-500 字",
    "story": "5-6 句话",
    "share": "3-5 句话",
}

_TYPE_LABEL: dict[str, str] = {
    "long":  "长文",
    "short": "短文",
    "story": "微故事",
    "share": "发现",
}


class EnqueueRequest(BaseModel):
    account_id: str
    topics: list[TopicSuggestion]


class EnqueueResponse(BaseModel):
    enqueued: int
    task_ids: list[str]
    pipeline_task_ids: list[int]


@router.post("/enqueue", response_model=EnqueueResponse)
async def enqueue_topics(body: EnqueueRequest, db: AsyncSession = Depends(get_db)):
    from pipeline_template import get_pipeline
    from models import PipelineTask, PublishAccount

    if not body.account_id or not body.account_id.strip():
        raise HTTPException(400, "account_id 必填")

    acc = await db.get(PublishAccount, body.account_id)
    if acc is None:
        raise HTTPException(400, f"account '{body.account_id}' not found")

    account_profile = {
        "name": acc.name,
        "platform": acc.platform,
        "positioning": acc.positioning,
        "audience": acc.audience,
        "tone": acc.tone,
        "topic_focus": acc.topic_focus or [],
        "taboo": acc.taboo or [],
        "word_range": acc.word_range or {},
        "image_style": acc.image_style,
        "cover_style": acc.cover_style or {},
        "voice_samples": acc.voice_samples or [],
        "style_rules": acc.style_rules or [],
    }

    kanban = HermesKanbanClient()
    task_ids: list[str] = []
    pipeline_task_ids: list[int] = []

    for topic in body.topics:
        pt = PipelineTask(
            account_id=body.account_id,
            title=topic.title,
            source_url="",
            task_ids={},
        )
        db.add(pt)
        await db.commit()
        await db.refresh(pt)

        ctx = {
            "title": topic.title,
            "account_id": body.account_id,
            "account_profile": account_profile,
            "content_type": topic.type,
            "content_type_label": _TYPE_LABEL.get(topic.type, topic.type),
            "word_range": _WORD_RANGE.get(topic.type, ""),
            "angle": topic.angle,
            "source_posts_md": "\n".join(
                f"- {p.username}: {p.content[:120]} [{p.url}]"
                for p in topic.source_posts
            ) or "（无参考帖子）",
            "pipeline_task_id": pt.id,
            "draft_id": 0,
        }

        flow = "topic_long" if topic.type == "long" else "topic_short"
        steps = get_pipeline(flow)

        step_task_ids: list[str] = []
        for step in steps:
            try:
                tid = await kanban.create_task(
                    title=step.title(ctx),
                    body=step.body(ctx),
                    assignee=step.assignee,
                    parents=[step_task_ids[-1]] if step_task_ids else None,
                )
            except Exception as e:
                raise HTTPException(500, f"入队失败: {e}")
            step_task_ids.append(tid)

        task_ids_map = {steps[i].role: step_task_ids[i] for i in range(len(steps))}
        pt.task_ids = task_ids_map
        await db.commit()

        task_ids.append(step_task_ids[0])
        pipeline_task_ids.append(pt.id)

    return EnqueueResponse(
        enqueued=len(task_ids),
        task_ids=task_ids,
        pipeline_task_ids=pipeline_task_ids,
    )
```

Also remove the old import that is no longer needed. The existing top-level imports in `topic_generator.py` include `from models import XPost, PublishAccount, TopicGeneratorCache` — update to add `PipelineTask`:

```python
from models import XPost, PublishAccount, TopicGeneratorCache, PipelineTask
```

And move `from pipeline_template import get_pipeline` to the function body (already done above) to avoid circular import risk.

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest tests/test_topic_generator.py -v 2>&1 | tail -30
```

Expected: all tests PASS.

- [ ] **Step 2.5: Run full backend test suite**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems python -m pytest -v 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add backend/routers/topic_generator.py backend/tests/test_topic_generator.py
git commit -m "feat(topic-generator): enqueue creates full pipeline chain per topic type"
```

---

## Task 3: Update frontend TypeScript API types

**Files:**
- Modify: `web/lib/api/topic-generator.ts`

- [ ] **Step 3.1: Update `EnqueueResponse` and `enqueueTopics` signature**

Replace the existing `EnqueueResponse` interface and `enqueueTopics` function:

```typescript
export interface EnqueueResponse {
  enqueued: number
  task_ids: string[]
  pipeline_task_ids: number[]
}

export async function enqueueTopics(opts: {
  account_id: string
  topics: TopicSuggestion[]
}): Promise<EnqueueResponse> {
  return apiFetch<EnqueueResponse>('/topic-generator/enqueue', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}
```

- [ ] **Step 3.2: Verify TypeScript compiles**

```bash
cd /workspace/projects/WeMediaStudio/web
source ~/.zshrc && pnpm tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: no errors related to `topic-generator.ts` or `TopicGeneratorClient.tsx`.

- [ ] **Step 3.3: Commit**

```bash
git add web/lib/api/topic-generator.ts
git commit -m "feat(frontend): update topic-generator API types for pipeline enqueue"
```

---

## Task 4: Update `TopicGeneratorClient.tsx` — lock button + success toast

**Files:**
- Modify: `web/app/trend-topics/TopicGeneratorClient.tsx`

- [ ] **Step 4.1: Lock the enqueue button when no account is selected**

Find the Footer action bar section (around line 294). Replace the `<Button>` disabled condition and add a hint:

```tsx
{/* Footer action bar */}
{cards.length > 0 && (
  <div className="border-t border-zinc-200 dark:border-zinc-800 px-6 py-3 flex items-center justify-between">
    <span className="text-sm text-zinc-500">
      已选 {selectedCount} 条
      {accountId === '__none__' && selectedCount > 0 && (
        <span className="ml-2 text-amber-500 text-xs">请先选择账号再入队</span>
      )}
    </span>
    <Button
      onClick={handleEnqueue}
      disabled={selectedCount === 0 || enqueueing || accountId === '__none__'}
    >
      {enqueueing
        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />入队中…</>
        : `入队选中项（${selectedCount}）`
      }
    </Button>
  </div>
)}
```

- [ ] **Step 4.2: Update `handleEnqueue` to pass `account_id` as required string and show "查看看板" action on success**

Replace the `handleEnqueue` function:

```tsx
async function handleEnqueue() {
  const toEnqueue = cards.filter(c => c.checked && !c.enqueued)
  if (!toEnqueue.length || accountId === '__none__') return
  setEnqueueing(true)
  try {
    const res = await enqueueTopics({
      account_id: accountId,
      topics: toEnqueue,
    })
    toast.success(`已入队 ${res.enqueued} 条选题`, {
      action: {
        label: '查看看板',
        onClick: () => { window.location.href = '/studio' },
      },
    })
    const titles = new Set(toEnqueue.map(t => t.title))
    setCards(prev =>
      prev.map(c => (titles.has(c.title) ? { ...c, checked: false, enqueued: true } : c))
    )
  } catch (e: unknown) {
    toast.error(e instanceof Error ? e.message : '入队失败')
  } finally {
    setEnqueueing(false)
  }
}
```

- [ ] **Step 4.3: Verify TypeScript compiles**

```bash
cd /workspace/projects/WeMediaStudio/web
source ~/.zshrc && pnpm tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

Expected: no errors.

- [ ] **Step 4.4: Commit**

```bash
git add web/app/trend-topics/TopicGeneratorClient.tsx
git commit -m "feat(topic-generator): lock enqueue button without account, add kanban link on success"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `long` → editor→writer→illustrator (Task 1 + Task 2)
- ✅ `short`/`story`/`share` → writer single-step (Task 1 + Task 2)
- ✅ Account required, 400 without account (Task 2)
- ✅ PipelineTask DB record created per topic (Task 2)
- ✅ Parent-child chain linking (Task 2, tested in step 2.1)
- ✅ Frontend button locked without account (Task 4)
- ✅ Success toast with "查看看板" (Task 4)
- ✅ TypeScript types updated (Task 3)

**No placeholders:** All steps contain actual code.

**Type consistency:**
- `EnqueueResponse.pipeline_task_ids: list[int]` (backend) matches `pipeline_task_ids: number[]` (frontend)
- `EnqueueRequest.account_id: str` (backend) matches `account_id: string` (frontend)
- `_WORD_RANGE` / `_TYPE_LABEL` dicts defined in Task 2 and used only in Task 2 (no cross-task reference)
- `TOPIC_LONG_PIPELINE` / `TOPIC_SHORT_PIPELINE` defined in Task 1, registered in same task, imported via `get_pipeline()` in Task 2

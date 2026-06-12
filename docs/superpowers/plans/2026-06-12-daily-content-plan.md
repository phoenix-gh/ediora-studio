# 每日自动内容计划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天 8 点由 wms_scout 总编为每个 active 账号生成「今日计划」，用户在独立页面 /daily-plan 勾选确认后按组入队现有 topic_long/topic_short 创作链（撞题组只跑一条链、一稿多发）。

**Architecture:** scheduler cron(8:00) → daily_planner 建 `DailyPlan(planning)` + 单棒 kanban 策划任务（蓝图 `DAILY_PLAN_PIPELINE`，assignee wms_scout）→ agent 调新 MCP 工具 `get_topic_candidates` 取候选池、`save_daily_plan` 写回 items（status→ready）→ 前端 /daily-plan 页确认 → `POST /daily-plan/{id}/enqueue` 按 group_key 去重复用 `_run_pipeline_chain` 建链。

**Tech Stack:** FastAPI + SQLAlchemy(async) + APScheduler + FastMCP；Next.js + shadcn/ui + sonner。spec 见 `docs/superpowers/specs/2026-06-12-daily-content-plan-design.md`。

**与 spec 的两处实现取舍**（已在自查时确定，不影响行为）：
1. `plan_date` 用 `String("YYYY-MM-DD")` 本地日期而非 `Date` 类型——models.py 现无 Date 导入，字符串可避免 sqlite/PG 时区歧义，且前端直接显示。
2. item 状态去掉 spec 里的 `approved`——勾选入队这个动作本身就是 approve，状态机收敛为 `suggested|skipped|enqueued`。

**环境注意（每次跑命令）：**
- 所有 Bash 先 `source ~/.zshrc`（否则找不到 node/conda）。
- Python 一律 `conda run -n wems` 前缀。
- 后端测试 cwd 是 `backend/`：`cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/<file> -v`。
- 全套测试有 **11 个既存失败 + 2 个 flake**（x_router 网络依赖、ref_collector 顺序污染），与本任务无关，别误判。
- 后端**无迁移框架**：新表由启动时 `create_all` 自建；既有表加列须手动 ALTER（见 Task 13）。

---

### Task 1: 数据模型 — DailyPlan / DailyPlanItem / PublishAccount.daily_quota

**Files:**
- Modify: `backend/models.py`（PublishAccount 加一列；文件末尾加两个新模型）
- Modify: `backend/schemas.py:6-62`（三个 PublishAccount schema 加 daily_quota）
- Test: `backend/tests/test_daily_plan_models.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_daily_plan_models.py
import sys, asyncio, pytest
from sqlalchemy import select


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def test_daily_plan_roundtrip_and_defaults(env):
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _run():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一",
                                  daily_quota={"long": 1, "short": 2}))
            plan = DailyPlan(plan_date="2026-06-12")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            db.add(DailyPlanItem(plan_id=plan.id, account_id="acc1",
                                 title="选题A", content_type="long",
                                 group_key="g1", is_primary=True))
            await db.commit()

            acc = await db.get(PublishAccount, "acc1")
            assert acc.daily_quota == {"long": 1, "short": 2}
            assert plan.status == "planning"
            assert plan.kanban_task_id == ""
            item = (await db.execute(select(DailyPlanItem))).scalars().one()
            assert item.status == "suggested"
            assert item.sources == []
            assert item.pipeline_task_id is None
            assert item.draft_id is None
    asyncio.new_event_loop().run_until_complete(_run())


def test_plan_date_unique(env):
    from sqlalchemy.exc import IntegrityError
    from database import SessionLocal
    from models import DailyPlan

    async def _run():
        async with SessionLocal() as db:
            db.add(DailyPlan(plan_date="2026-06-12"))
            await db.commit()
            db.add(DailyPlan(plan_date="2026-06-12"))
            with pytest.raises(IntegrityError):
                await db.commit()
    asyncio.new_event_loop().run_until_complete(_run())


def test_publish_account_schemas_carry_daily_quota(env):
    from schemas import PublishAccountCreate, PublishAccountOut, PublishAccountUpdate
    c = PublishAccountCreate(id="a", name="n")
    assert c.daily_quota == {}
    u = PublishAccountUpdate(daily_quota={"long": 1})
    assert u.model_dump(exclude_none=True) == {"daily_quota": {"long": 1}}
    assert "daily_quota" in PublishAccountOut.model_fields
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_models.py -v`
Expected: FAIL（`daily_quota` 不是 PublishAccount 字段 / `DailyPlan` 导入失败）

- [ ] **Step 3: 改 models.py**

在 `PublishAccount` 的 `app_secret` 行后（`backend/models.py:41` 附近）加一列：

```python
    daily_quota: Mapped[dict] = mapped_column(JSON, default=dict)  # {"long":1,"short":2}；空=不参与每日计划
```

在 `models.py` 文件末尾追加两个模型：

```python
class DailyPlan(Base):
    """每日内容计划：8 点总编策划任务的载体，items 确认后入队创作链。"""
    __tablename__ = "daily_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_date: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)  # 本地日期 "YYYY-MM-DD"
    status: Mapped[str] = mapped_column(String, default="planning", index=True)  # planning|ready|failed
    kanban_task_id: Mapped[str] = mapped_column(String, default="")
    planner_note: Mapped[str] = mapped_column(Text, default="")  # 总编留言
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class DailyPlanItem(Base):
    """计划里的一条选题。后续发布排期/效果回流都挂在这个锚点上。"""
    __tablename__ = "daily_plan_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    angle: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    content_type: Mapped[str] = mapped_column(String, default="long")  # long|short|story|share
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{platform,title,url}]
    group_key: Mapped[str] = mapped_column(String, default="", index=True)  # 非空=撞题组，共享一稿
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)  # 组内主笔（用谁的画像写）
    status: Mapped[str] = mapped_column(String, default="suggested", index=True)  # suggested|skipped|enqueued
    pipeline_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

- [ ] **Step 4: 改 schemas.py**

`PublishAccountCreate`（`app_secret: str = ""` 之后）加：

```python
    daily_quota: dict = Field(default_factory=dict)
```

`PublishAccountOut`（`app_secret: str` 之后）加：

```python
    daily_quota: dict
```

`PublishAccountUpdate`（`app_secret: Optional[str] = None` 之后）加：

```python
    daily_quota: Optional[dict] = None
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_models.py -v`
Expected: 3 PASS

- [ ] **Step 6: 既有 publish_accounts / studio 测试无回归**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_models_schema.py tests/test_studio_enqueue_manual.py -v`
Expected: PASS（与改动前相同）

- [ ] **Step 7: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/models.py backend/schemas.py backend/tests/test_daily_plan_models.py
git commit -m "feat(daily-plan): DailyPlan/DailyPlanItem 模型 + 账号 daily_quota 列"
```

---

### Task 2: DAILY_PLAN_PIPELINE 蓝图

**Files:**
- Modify: `backend/pipeline_template.py`（REPO_INTRO_PIPELINE 之后、PIPELINES 注册表之前插入；注册表加一行）
- Test: `backend/tests/test_pipeline_template_daily_plan.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_pipeline_template_daily_plan.py
def _ctx():
    return {
        "date_str": "2026-06-12",
        "plan_id": 7,
        "accounts_md": "### 号一（account_id: acc1 / wechat）\n- 今日配额 daily_quota：{\"long\": 1}",
        "recent_titles_md": "- 昨天写过的标题",
    }


def test_daily_plan_blueprint_registered_single_step():
    from pipeline_template import get_pipeline
    steps = get_pipeline("daily_plan")
    assert len(steps) == 1
    assert steps[0].role == "planner"
    assert steps[0].assignee == "wms_scout"


def test_daily_plan_body_contains_inputs_and_workflow():
    from pipeline_template import get_pipeline
    step = get_pipeline("daily_plan")[0]
    title = step.title(_ctx())
    body = step.body(_ctx())
    assert "2026-06-12" in title
    # 输入注入
    assert "acc1" in body
    assert "昨天写过的标题" in body
    # 工作流硬指令
    assert "get_topic_candidates" in body
    assert "save_daily_plan(plan_id=7" in body
    assert "group_key" in body
    assert "is_primary" in body
    assert "kanban_complete" in body
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_pipeline_template_daily_plan.py -v`
Expected: FAIL with `unknown flow 'daily_plan'`

- [ ] **Step 3: 加蓝图并注册**

在 `backend/pipeline_template.py` 的 `REPO_INTRO_PIPELINE` 定义之后、`PIPELINES` 字典之前插入：

```python
# ── daily_plan：每日内容计划 策划单棒（wms_scout 当总编） ────────────────────
# 产出不是稿子而是计划：按账号画像+配额从候选池选题，save_daily_plan 写回，
# 用户在 /daily-plan 页确认后才入队 topic_long/topic_short 创作链。
DAILY_PLAN_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="planner",
        assignee="wms_scout",
        title=lambda c: f"今日内容计划：{c['date_str']}",
        body=lambda c: f"""flow: daily_plan
plan_id: {c['plan_id']}

# 制定 {c['date_str']} 各账号内容计划

你是今天的总编。为下列每个账号挑选今天要写的选题，产出今日计划。

{c['accounts_md']}

## 近 7 天已写标题（禁止重复选题）
{c['recent_titles_md']}

## 工作流
1. 调 `get_topic_candidates()` 拉取近 24h 候选池（X 热帖 / GitHub release / 论文 / 36氪 /
   掘金 / V2EX / Reddit / Product Hunt / YouTube / 选题库 / 写作方案）
2. 可用 web 工具核实候选热点、补充今天的新动态
3. 按每个账号的画像（定位/受众/选题重点/禁区）和 daily_quota 分配选题，每条给出：
   - `title`（拟发标题）、`angle`（一句话切入角度）、`reason`（为什么今天写它）
   - `content_type`：long|short|story|share（story/share 计入 short 配额）
   - `sources`：参考来源 `[{{"platform": "...", "title": "...", "url": "..."}}]`
   - **撞题公用**：同一选题适合多个账号时，每个账号各建一条 item，填**相同的
     `group_key`**（如 "g1"），把画像最适合写这篇的那条标 `is_primary=true`——
     一组只跑一条创作链、共享一稿。同组必须同 content_type。
   - 不得与「近 7 天已写标题」重复
4. `save_daily_plan(plan_id={c['plan_id']}, items=[...], note='<给运营的一句话总编留言>')`
5. `kanban_complete(summary='今日计划 N 条', metadata={{"plan_id": {c['plan_id']}, "item_count": N}})`
""".strip(),
    ),
]
```

`PIPELINES` 注册表加一行（`"repo_intro": REPO_INTRO_PIPELINE,` 之后）：

```python
    "daily_plan": DAILY_PLAN_PIPELINE,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_pipeline_template_daily_plan.py tests/test_pipeline_template_manual.py tests/test_pipeline_template_topic.py -v`
Expected: 全 PASS（含既有蓝图测试无回归）

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/pipeline_template.py backend/tests/test_pipeline_template_daily_plan.py
git commit -m "feat(daily-plan): DAILY_PLAN_PIPELINE 总编策划单棒蓝图"
```

---

### Task 3: daily_planner.create_today_plan

**Files:**
- Create: `backend/daily_planner.py`
- Test: `backend/tests/test_daily_planner.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_daily_planner.py
import sys, asyncio, pytest
from sqlalchemy import select


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "logger", "scheduler",
                            "daily_planner", "hermes_kanban_client", "pipeline_template")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def _seed_account(**kw):
    from database import SessionLocal
    from models import PublishAccount
    defaults = dict(id="acc1", name="号一", platform="wechat",
                    positioning="AI 观察", audience="技术人", tone="犀利",
                    topic_focus=["AI"], taboo=["政治"],
                    daily_quota={"long": 1, "short": 2})
    defaults.update(kw)
    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(**defaults))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_mk())


class FakeKanban:
    created: list[dict] = []
    def __init__(self, *a, **kw): pass
    async def create_task(self, *, title, body, assignee, parents=None):
        FakeKanban.created.append({"title": title, "body": body, "assignee": assignee})
        return f"t_plan_{len(FakeKanban.created)}"


@pytest.fixture
def fake_kanban(env, monkeypatch):
    FakeKanban.created = []
    import hermes_kanban_client
    monkeypatch.setattr(hermes_kanban_client, "HermesKanbanClient", FakeKanban)
    return FakeKanban


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_create_plan_creates_row_and_kanban_task(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    plan = _run(create_today_plan())
    assert plan is not None
    assert plan.status == "planning"
    assert plan.kanban_task_id == "t_plan_1"
    assert len(fake_kanban.created) == 1
    task = fake_kanban.created[0]
    assert task["assignee"] == "wms_scout"
    assert "acc1" in task["body"]            # 账号画像注入
    assert '"long": 1' in task["body"]       # 配额注入
    assert f"plan_id={plan.id}" in task["body"]


def test_same_day_idempotent(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    p1 = _run(create_today_plan())
    p2 = _run(create_today_plan())
    assert p2.id == p1.id
    assert len(fake_kanban.created) == 1     # 没有重复建任务


def test_force_recreates_plan_and_items(fake_kanban):
    _seed_account()
    from daily_planner import create_today_plan
    from database import SessionLocal
    from models import DailyPlanItem
    p1 = _run(create_today_plan())

    async def _add_item():
        async with SessionLocal() as db:
            db.add(DailyPlanItem(plan_id=p1.id, account_id="acc1", title="旧item"))
            await db.commit()
    _run(_add_item())

    p2 = _run(create_today_plan(force=True))
    # 注意：不能断言 p2.id != p1.id——SQLite 删掉最大 rowid 后新插入会复用同一 id
    assert p2.kanban_task_id == "t_plan_2"
    assert len(fake_kanban.created) == 2

    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlanItem))).scalars().all())
    assert _run(_count()) == 0               # 旧 items 连带删除


def test_skip_when_no_quota(fake_kanban):
    _seed_account(daily_quota={})
    from daily_planner import create_today_plan
    from database import SessionLocal
    from models import DailyPlan
    plan = _run(create_today_plan())
    assert plan is None
    assert fake_kanban.created == []

    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlan))).scalars().all())
    assert _run(_count()) == 0


def test_recent_draft_titles_in_body(fake_kanban):
    _seed_account()
    from database import SessionLocal
    from models import ArticleDraft

    async def _add_draft():
        async with SessionLocal() as db:
            db.add(ArticleDraft(topic_id="t1", title="昨天已写过的稿子"))
            await db.commit()
    _run(_add_draft())

    from daily_planner import create_today_plan
    _run(create_today_plan())
    assert "昨天已写过的稿子" in fake_kanban.created[0]["body"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_planner.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'daily_planner'`

- [ ] **Step 3: 写 daily_planner.py**

```python
# backend/daily_planner.py
"""每日内容计划：为 active 账号生成「今日计划」总编策划任务（wms_scout 单棒）。

调用方：scheduler 8 点 cron / POST /daily-plan/generate（重新生成）。
agent 产出经 MCP save_daily_plan 写回 DailyPlanItem，用户确认后入队创作链。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete as sa_delete, select

from database import SessionLocal
from models import ArticleDraft, DailyPlan, DailyPlanItem, PublishAccount


def today_str() -> str:
    """本地日期（cron 按本地 8 点跑，计划也按本地日界）。"""
    return datetime.now().strftime("%Y-%m-%d")


def _build_accounts_md(accounts: list[PublishAccount]) -> str:
    blocks = []
    for acc in accounts:
        blocks.append(
            f"### {acc.name}（account_id: {acc.id} / {acc.platform}）\n"
            f"- 定位：{acc.positioning or '（未填）'}\n"
            f"- 受众：{acc.audience or '（未填）'}\n"
            f"- 调性：{acc.tone or '（未填）'}\n"
            f"- 选题重点：{'、'.join(acc.topic_focus) if acc.topic_focus else '不限'}\n"
            f"- 禁区：{'、'.join(acc.taboo) if acc.taboo else '无'}\n"
            f"- 今日配额 daily_quota：{json.dumps(acc.daily_quota or {}, ensure_ascii=False)}"
        )
    return "## 账号与配额\n\n" + "\n\n".join(blocks)


async def _recent_titles_md(db, days: int = 7) -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    item_titles = (await db.execute(
        select(DailyPlanItem.title).where(DailyPlanItem.created_at >= cutoff)
    )).scalars().all()
    draft_titles = (await db.execute(
        select(ArticleDraft.title).where(ArticleDraft.created_at >= cutoff)
    )).scalars().all()
    titles = [t for t in dict.fromkeys([*item_titles, *draft_titles]) if t and t.strip()]
    if not titles:
        return "（近 7 天无产出）"
    return "\n".join(f"- {t}" for t in titles[:100])


async def create_today_plan(*, force: bool = False) -> DailyPlan | None:
    """生成今天的 DailyPlan + 总编策划任务。

    - 当天已有计划且非 force：直接返回现有计划（幂等，cron 重跑安全）
    - force：删除当天计划（连带 items）重建
    - 无 active 账号或配额全空：记日志返回 None
    - kanban 建任务失败：计划标 failed 后原样抛出（调用方决定如何上报）
    """
    from logger import log
    from hermes_kanban_client import HermesKanbanClient
    from pipeline_template import get_pipeline

    date_str = today_str()

    async with SessionLocal() as db:
        existing = (await db.execute(
            select(DailyPlan).where(DailyPlan.plan_date == date_str)
        )).scalar_one_or_none()
        if existing is not None:
            if not force:
                return existing
            await db.execute(sa_delete(DailyPlanItem).where(DailyPlanItem.plan_id == existing.id))
            await db.delete(existing)
            await db.commit()

        accounts = [
            a for a in (await db.execute(
                select(PublishAccount)
                .where(PublishAccount.is_active == True)  # noqa: E712
                .order_by(PublishAccount.name)
            )).scalars().all()
            if a.daily_quota
        ]
        if not accounts:
            await log("daily_plan", "skip", "无 active 账号或所有 daily_quota 为空，跳过今日计划")
            return None

        recent_md = await _recent_titles_md(db)

        plan = DailyPlan(plan_date=date_str, status="planning")
        db.add(plan)
        await db.commit()
        await db.refresh(plan)
        plan_id = plan.id

    ctx = {
        "date_str": date_str,
        "plan_id": plan_id,
        "accounts_md": _build_accounts_md(accounts),
        "recent_titles_md": recent_md,
    }
    step = get_pipeline("daily_plan")[0]
    try:
        tid = await HermesKanbanClient().create_task(
            title=step.title(ctx), body=step.body(ctx), assignee=step.assignee,
        )
    except Exception as e:
        async with SessionLocal() as db:
            p = await db.get(DailyPlan, plan_id)
            if p is not None:
                p.status = "failed"
                await db.commit()
        await log("daily_plan", "error", "今日计划策划任务创建失败", str(e)[:500])
        raise

    async with SessionLocal() as db:
        p = await db.get(DailyPlan, plan_id)
        if p is not None:
            p.kanban_task_id = tid
            await db.commit()
    await log("daily_plan", "ok", f"今日计划任务已创建（{date_str}），等待总编产出")
    async with SessionLocal() as db:
        return await db.get(DailyPlan, plan_id)
```

注意：`HermesKanbanClient` 在函数体内 import（`from hermes_kanban_client import ...` 写在 `create_today_plan` 顶部），保证测试 monkeypatch `hermes_kanban_client.HermesKanbanClient` 生效。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_planner.py -v`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/daily_planner.py backend/tests/test_daily_planner.py
git commit -m "feat(daily-plan): create_today_plan 幂等生成今日计划 + 总编任务"
```

---

### Task 4: scheduler 8 点 cron job

**Files:**
- Modify: `backend/scheduler.py`（加 `scheduled_daily_plan`；`register_jobs` jobs 列表加一行）
- Test: `backend/tests/test_daily_planner.py`（追加一个测试）

- [ ] **Step 1: 追加失败测试**

在 `backend/tests/test_daily_planner.py` 末尾追加：

```python
def test_register_jobs_includes_daily_plan_cron(env):
    import scheduler
    class FakeSched:
        def __init__(self): self.jobs = {}
        def add_job(self, func, **kw): self.jobs[kw.get("id")] = kw
    fs = FakeSched()
    scheduler.register_jobs(fs, {})
    assert "daily_plan" in fs.jobs
    assert fs.jobs["daily_plan"].get("trigger") == "cron"
    assert fs.jobs["daily_plan"].get("hour") == 8
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_planner.py::test_register_jobs_includes_daily_plan_cron -v`
Expected: FAIL（`"daily_plan" not in fs.jobs`）

- [ ] **Step 3: 改 scheduler.py**

在 `scheduled_x_reply_scout` 函数之后、`register_jobs` 之前加：

```python
async def scheduled_daily_plan():
    """每天 8 点：为每个 active 账号生成今日内容计划（wms_scout 总编单棒）。
    create_today_plan 自带「当天已有计划则跳过」幂等守卫，重启重跑安全。"""
    from logger import log
    try:
        from daily_planner import create_today_plan
        await create_today_plan()
    except Exception as e:
        await log("daily_plan", "error", "今日计划生成异常", str(e))
```

`register_jobs` 的 `jobs` 列表末尾加一行（注意 cron 触发器不带 `next_run_time`）：

```python
        (scheduled_daily_plan,          dict(trigger="cron",     hour=8, minute=0,    id="daily_plan")),
```

- [ ] **Step 4: 跑测试确认通过（含调度器既有测试）**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_planner.py tests/test_ref_scheduler.py -v`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/scheduler.py backend/tests/test_daily_planner.py
git commit -m "feat(daily-plan): 每天 8 点 cron 触发今日计划生成"
```

---

### Task 5: MCP 工具 get_topic_candidates

**Files:**
- Modify: `backend/mcp_server.py`（顶部 import 加 `delete as sa_delete`；文件末尾加工具）
- Test: `backend/tests/test_mcp_daily_plan_tools.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_mcp_daily_plan_tools.py
import sys, asyncio, pytest
from datetime import datetime, timezone, timedelta


@pytest.fixture
def env(monkeypatch, tmp_path):
    db_file = tmp_path / "t.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "config", "mcp_server")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _setup():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_setup())


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _now():
    return datetime.now(timezone.utc)


def _seed(model, **kw):
    from database import SessionLocal
    async def _mk():
        async with SessionLocal() as db:
            db.add(model(**kw))
            await db.commit()
    _run(_mk())


def _seed_basics():
    from models import XPost, KrArticle, Topic, WritingPlan
    _seed(XPost, id="x1", subscription_id=1, username="alice", content="大模型价格战开打",
          url="https://x.com/1", published_at=_now(), likes=100, reposts=50, is_reply=False)
    _seed(KrArticle, id="k1", feed_type="hot", title="某 AI 公司融资",
          url="https://36kr.com/1", published_at=_now(), stat_read=999)
    _seed(Topic, id="t1", title="选题库里的待写选题", score=4.5)
    _seed(WritingPlan, title="长期写作方案A", strategy="持续追踪 agent 生态")


def test_candidates_unified_shape(env):
    _seed_basics()
    import mcp_server
    res = _run(mcp_server.get_topic_candidates())
    assert {c["source"] for c in res} >= {"x", "kr", "topic_library", "writing_plan"}
    for c in res:
        assert set(c) == {"source", "title", "summary", "url", "heat", "published_at"}
    x = [c for c in res if c["source"] == "x"][0]
    assert x["heat"] == 150  # likes + reposts


def test_candidates_sources_filter(env):
    _seed_basics()
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["x"]))
    assert res and all(c["source"] == "x" for c in res)


def test_candidates_24h_window(env):
    from models import XPost
    _seed(XPost, id="old", subscription_id=1, username="bob", content="三天前的旧帖",
          url="https://x.com/old", published_at=_now() - timedelta(days=3),
          likes=9999, reposts=0, is_reply=False)
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["x"]))
    assert res == []


def test_candidates_limit_per_source(env):
    from models import KrArticle
    for i in range(3):
        _seed(KrArticle, id=f"k{i}", feed_type="hot", title=f"快讯{i}",
              url=f"https://36kr.com/{i}", published_at=_now(), stat_read=i)
    import mcp_server
    res = _run(mcp_server.get_topic_candidates(sources=["kr"], limit_per_source=1))
    assert len(res) == 1
    assert res[0]["title"] == "快讯2"  # 按 stat_read 降序取 top
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py -v`
Expected: FAIL with `AttributeError: ... 'get_topic_candidates'`

- [ ] **Step 3: 实现工具**

`backend/mcp_server.py` 顶部 `from sqlalchemy import select, desc` 改为：

```python
from sqlalchemy import select, desc, delete as sa_delete
```

文件末尾（`get_account_profile` 之后）追加：

```python
# ── 每日内容计划（daily_plan 总编任务专用） ────────────────────────────────────

@mcp.tool()
async def get_topic_candidates(
    sources: Optional[list[str]] = None,
    limit_per_source: int = 10,
) -> list[dict]:
    """
    统一选题候选池：近 24h 各信息源高热内容 + 选题库 + 写作方案。

    供每日计划总编（daily_plan 任务）调用。统一结构：
    {source, title, summary, url, heat, published_at}
    source ∈ x / github_release / paper / kr / juejin / v2ex / reddit /
             producthunt / youtube / topic_library / writing_plan
    sources 传子集可只拉部分源；limit_per_source 每源上限（X 固定 50，写作方案固定 20）。
    """
    from models import (XPost, GithubRelease, Paper, KrArticle, JuejinArticle,
                        V2exTopic, RedditPost, ProductHuntPost, YoutubeVideo,
                        Topic, WritingPlan)

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    lim = max(1, min(int(limit_per_source), 50))
    want = set(sources) if sources else None

    def _on(key: str) -> bool:
        return want is None or key in want

    def _c(source, title, summary, url, heat, published_at) -> dict:
        return {"source": source, "title": (title or "")[:120],
                "summary": (summary or "")[:300], "url": url or "",
                "heat": int(heat or 0), "published_at": _fmt_dt(published_at)}

    out: list[dict] = []
    async with SessionLocal() as db:
        if _on("x"):
            rows = (await db.execute(
                select(XPost)
                .where(XPost.published_at >= since, XPost.is_reply == False)  # noqa: E712
                .order_by(desc(XPost.likes + XPost.reposts)).limit(50)
            )).scalars().all()
            out += [_c("x", f"@{p.username}: {p.content[:80]}", p.content, p.url,
                       p.likes + p.reposts, p.published_at) for p in rows]

        if _on("github_release"):
            rows = (await db.execute(
                select(GithubRelease).where(GithubRelease.published_at >= since)
                .order_by(desc(GithubRelease.published_at)).limit(lim)
            )).scalars().all()
            out += [_c("github_release", f"{r.repo_id} {r.tag_name}", r.body,
                       r.html_url, 0, r.published_at) for r in rows]

        if _on("paper"):
            rows = (await db.execute(
                select(Paper).where(Paper.collected_at >= since)
                .order_by(desc(Paper.collected_at)).limit(lim)
            )).scalars().all()
            out += [_c("paper", p.title_cn or p.title, p.abstract_cn or p.abstract,
                       p.arxiv_url, 0, p.submitted_at) for p in rows]

        if _on("kr"):
            rows = (await db.execute(
                select(KrArticle).where(KrArticle.published_at >= since)
                .order_by(desc(KrArticle.stat_read)).limit(lim)
            )).scalars().all()
            out += [_c("kr", a.title, a.summary, a.url, a.stat_read, a.published_at)
                    for a in rows]

        if _on("juejin"):
            rows = (await db.execute(
                select(JuejinArticle).where(JuejinArticle.published_at >= since)
                .order_by(desc(JuejinArticle.view_count)).limit(lim)
            )).scalars().all()
            out += [_c("juejin", a.title, a.brief, a.url, a.view_count, a.published_at)
                    for a in rows]

        if _on("v2ex"):
            rows = (await db.execute(
                select(V2exTopic).where(V2exTopic.published_at >= since)
                .order_by(desc(V2exTopic.replies)).limit(lim)
            )).scalars().all()
            out += [_c("v2ex", t.title, t.content, t.url, t.replies, t.published_at)
                    for t in rows]

        if _on("reddit"):
            rows = (await db.execute(
                select(RedditPost).where(RedditPost.published_at >= since)
                .order_by(desc(RedditPost.score)).limit(lim)
            )).scalars().all()
            out += [_c("reddit", p.title, p.body, p.url, p.score, p.published_at)
                    for p in rows]

        if _on("producthunt"):
            rows = (await db.execute(
                select(ProductHuntPost).where(ProductHuntPost.published_at >= since)
                .order_by(desc(ProductHuntPost.votes)).limit(lim)
            )).scalars().all()
            out += [_c("producthunt", f"{p.title} — {p.tagline}", p.description,
                       p.url, p.votes, p.published_at) for p in rows]

        if _on("youtube"):
            rows = (await db.execute(
                select(YoutubeVideo).where(YoutubeVideo.published_at >= since)
                .order_by(desc(YoutubeVideo.views)).limit(lim)
            )).scalars().all()
            out += [_c("youtube", f"[{v.channel_name}] {v.title}", v.description,
                       v.url, v.views, v.published_at) for v in rows]

        if _on("topic_library"):
            rows = (await db.execute(
                select(Topic).where(Topic.status == "pending")
                .order_by(desc(Topic.score)).limit(lim)
            )).scalars().all()
            out += [_c("topic_library", t.title, t.summary or t.recommend_reason,
                       "", int(t.score * 10), t.created_at) for t in rows]

        if _on("writing_plan"):
            rows = (await db.execute(
                select(WritingPlan).where(WritingPlan.status == "active")
                .order_by(WritingPlan.priority).limit(20)
            )).scalars().all()
            out += [_c("writing_plan", w.title, w.strategy, "", 0, w.updated_at)
                    for w in rows]

    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py tests/test_mcp_search_materials.py -v`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/mcp_server.py backend/tests/test_mcp_daily_plan_tools.py
git commit -m "feat(daily-plan): MCP get_topic_candidates 统一候选池"
```

---

### Task 6: MCP 工具 save_daily_plan + get_recent_outputs

**Files:**
- Modify: `backend/mcp_server.py`（紧接 get_topic_candidates 之后追加两个工具）
- Test: `backend/tests/test_mcp_daily_plan_tools.py`（追加）

- [ ] **Step 1: 追加失败测试**

在 `backend/tests/test_mcp_daily_plan_tools.py` 末尾追加：

```python
def _seed_plan_and_account():
    from models import DailyPlan, PublishAccount
    from database import SessionLocal
    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date="2026-06-12")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            return plan.id
    return _run(_mk())


def _item(**kw):
    base = dict(account_id="acc1", title="选题A", angle="角度", reason="理由",
                content_type="long", sources=[{"platform": "x", "title": "src", "url": "u"}],
                group_key="", is_primary=False)
    base.update(kw)
    return base


def test_save_daily_plan_replaces_and_marks_ready(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    r1 = _run(mcp_server.save_daily_plan(plan_id, [_item()], note="第一版"))
    assert r1 == {"ok": True, "plan_id": plan_id, "item_count": 1}
    r2 = _run(mcp_server.save_daily_plan(
        plan_id, [_item(title="选题B"), _item(title="选题C", account_id="acc2")], note="第二版"))
    assert r2["item_count"] == 2

    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem
    from sqlalchemy import select
    async def _check():
        async with SessionLocal() as db:
            items = (await db.execute(select(DailyPlanItem))).scalars().all()
            plan = await db.get(DailyPlan, plan_id)
            return [i.title for i in items], plan.status, plan.planner_note, items
    titles, status, note, items = _run(_check())
    assert sorted(titles) == ["选题B", "选题C"]   # 整体替换，没有残留「选题A」
    assert status == "ready"
    assert note == "第二版"
    assert all(i.is_primary for i in items)        # 无组 item 强制主笔


def test_save_daily_plan_validates_account_and_type(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(account_id="ghost")]))
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(content_type="poem")]))
    assert "error" in _run(mcp_server.save_daily_plan(plan_id, [_item(title="  ")]))
    assert "error" in _run(mcp_server.save_daily_plan(99999, [_item()]))


def test_save_daily_plan_group_constraints(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    # 同组异体裁 → 拒绝
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1", is_primary=True, content_type="long"),
        _item(group_key="g1", account_id="acc2", content_type="short"),
    ]))
    assert "error" in r
    # 同组无主笔 → 拒绝
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1"), _item(group_key="g1", account_id="acc2"),
    ]))
    assert "error" in r
    # 合法组 → 通过
    r = _run(mcp_server.save_daily_plan(plan_id, [
        _item(group_key="g1", is_primary=True),
        _item(group_key="g1", account_id="acc2"),
    ]))
    assert r.get("ok") is True


def test_get_recent_outputs(env):
    plan_id = _seed_plan_and_account()
    import mcp_server
    _run(mcp_server.save_daily_plan(plan_id, [_item(title="计划里的标题")]))
    from database import SessionLocal
    from models import ArticleDraft
    async def _draft():
        async with SessionLocal() as db:
            db.add(ArticleDraft(topic_id="t1", title="草稿标题"))
            await db.commit()
    _run(_draft())
    res = _run(mcp_server.get_recent_outputs())
    titles = {r["title"] for r in res}
    assert {"计划里的标题", "草稿标题"} <= titles
    assert all(set(r) == {"type", "title"} for r in res)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py -v`
Expected: 新增 4 个 FAIL（`save_daily_plan` 不存在），既有 4 个 PASS

- [ ] **Step 3: 实现两个工具**

紧接 `get_topic_candidates` 之后追加：

```python
_PLAN_CONTENT_TYPES = {"long", "short", "story", "share"}


@mcp.tool()
async def save_daily_plan(plan_id: int, items: list[dict], note: str = "") -> dict:
    """
    写回今日计划（daily_plan 总编任务的产出）。重复调用整体替换（幂等），成功后计划置 ready。

    items 每条：{account_id, title, angle, reason, content_type, sources, group_key, is_primary}
    - content_type ∈ long|short|story|share
    - 撞题公用：同 group_key 的 items 共享一稿，必须同 content_type，且恰好一条 is_primary=true
    - 无 group_key 的 item 各自独立（is_primary 自动置 true）
    校验失败返回 {"error": "..."}，不落任何数据。
    """
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async with SessionLocal() as db:
        plan = await db.get(DailyPlan, plan_id)
        if plan is None:
            return {"error": f"daily plan {plan_id} not found"}

        acc_ids = set((await db.execute(select(PublishAccount.id))).scalars().all())

        groups: dict[str, list[dict]] = {}
        for i, it in enumerate(items):
            if not (it.get("title") or "").strip():
                return {"error": f"items[{i}]: title 不能为空"}
            if it.get("account_id") not in acc_ids:
                return {"error": f"items[{i}]: account_id '{it.get('account_id')}' 不存在"}
            ct = it.get("content_type", "long")
            if ct not in _PLAN_CONTENT_TYPES:
                return {"error": f"items[{i}]: content_type '{ct}' 非法（long|short|story|share）"}
            gk = (it.get("group_key") or "").strip()
            if gk:
                groups.setdefault(gk, []).append(it)

        for gk, members in groups.items():
            if len({m.get("content_type", "long") for m in members}) > 1:
                return {"error": f"group '{gk}' 内 content_type 不一致（同组必须同体裁）"}
            primaries = [m for m in members if m.get("is_primary")]
            if len(primaries) != 1:
                return {"error": f"group '{gk}' 必须恰好一条 is_primary=true（当前 {len(primaries)} 条）"}

        await db.execute(sa_delete(DailyPlanItem).where(DailyPlanItem.plan_id == plan_id))
        for it in items:
            gk = (it.get("group_key") or "").strip()
            db.add(DailyPlanItem(
                plan_id=plan_id,
                account_id=it["account_id"],
                title=it["title"].strip(),
                angle=(it.get("angle") or "").strip(),
                reason=(it.get("reason") or "").strip(),
                content_type=it.get("content_type", "long"),
                sources=it.get("sources") or [],
                group_key=gk,
                is_primary=bool(it.get("is_primary")) if gk else True,
            ))
        plan.status = "ready"
        plan.planner_note = note or ""
        await db.commit()
        return {"ok": True, "plan_id": plan_id, "item_count": len(items)}


@mcp.tool()
async def get_recent_outputs(days: int = 7) -> list[dict]:
    """
    近 N 天已计划/已产出的标题清单（查重用）。daily_plan 任务书里通常已附，此工具备查。
    返回 [{type: "plan_item"|"draft", title}]。
    """
    from models import ArticleDraft, DailyPlanItem

    cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days), 30)))
    out: list[dict] = []
    async with SessionLocal() as db:
        for t in (await db.execute(
            select(DailyPlanItem.title).where(DailyPlanItem.created_at >= cutoff)
        )).scalars().all():
            if t and t.strip():
                out.append({"type": "plan_item", "title": t})
        for t in (await db.execute(
            select(ArticleDraft.title).where(ArticleDraft.created_at >= cutoff)
        )).scalars().all():
            if t and t.strip():
                out.append({"type": "draft", "title": t})
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_mcp_daily_plan_tools.py -v`
Expected: 8 PASS

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/mcp_server.py backend/tests/test_mcp_daily_plan_tools.py
git commit -m "feat(daily-plan): MCP save_daily_plan（组校验+整体替换）+ get_recent_outputs"
```

---

### Task 7: studio EnqueueOut 回传 pipeline_task_id（前置小改）

入队接口（Task 9）要把 `pipeline_task_id` 回填到 plan item 上，但 `_run_pipeline_chain` 现在不回传它。

**Files:**
- Modify: `backend/routers/studio.py:283-285`（EnqueueOut）、`backend/routers/studio.py:383`（return）
- Test: `backend/tests/test_studio_enqueue_manual.py`（既有测试加一行断言）

- [ ] **Step 1: 在既有测试加失败断言**

`test_enqueue_manual_persists_pipeline_task` 中 `assert row.task_ids == {...}` 之后加：

```python
    assert r.json()["pipeline_task_id"] == row.id
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_studio_enqueue_manual.py::test_enqueue_manual_persists_pipeline_task -v`
Expected: FAIL with `KeyError: 'pipeline_task_id'`

- [ ] **Step 3: 改 studio.py**

`EnqueueOut` 改为：

```python
class EnqueueOut(BaseModel):
    task_id: str
    task_ids: list[str] = []
    pipeline_task_id: int = 0
```

`_run_pipeline_chain` 最后的 return 改为：

```python
    return EnqueueOut(task_id=task_id_list[0], task_ids=task_id_list,
                      pipeline_task_id=pipeline_task_id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_studio_enqueue_manual.py tests/test_studio_illustrate.py -v`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/routers/studio.py backend/tests/test_studio_enqueue_manual.py
git commit -m "feat(studio): EnqueueOut 回传 pipeline_task_id"
```

---

### Task 8: routers/daily_plan.py — 查询 / 生成 / 跳过

**Files:**
- Create: `backend/routers/daily_plan.py`
- Modify: `backend/main.py:13`（import 列表加 `daily_plan`）+ include_router 区域加一行
- Test: `backend/tests/test_daily_plan_router.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_daily_plan_router.py
import sys, asyncio, pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "schemas",
                            "hermes_kanban_client", "mcp_server", "pipeline_template",
                            "daily_planner", "logger", "scheduler")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _seed_plan(client, *, date="2026-06-12", status="ready"):
    """返回 (plan_id, item_ids)。两个账号、三条 item：acc1 两条（g1 组主笔 + 独立），acc2 一条（g1 组员）。"""
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", positioning="AI 观察"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date=date, status=status, planner_note="今天就这些")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            items = [
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="撞题选题",
                              angle="角度1", content_type="short", group_key="g1",
                              is_primary=True, sources=[{"platform": "x", "title": "s", "url": "u"}]),
                DailyPlanItem(plan_id=plan.id, account_id="acc2", title="撞题选题",
                              angle="角度1", content_type="short", group_key="g1",
                              is_primary=False),
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="独立长文",
                              angle="角度2", content_type="long"),
            ]
            db.add_all(items)
            await db.commit()
            return plan.id, [i.id for i in items]
    return _run(_mk())


def test_today_returns_null_when_absent(client):
    r = client.get("/api/daily-plan/today")
    assert r.status_code == 200
    assert r.json() == {"plan": None}


def test_today_returns_plan_with_items(client):
    plan_id, _ = _seed_plan(client)
    r = client.get("/api/daily-plan/today?date=2026-06-12")
    assert r.status_code == 200
    plan = r.json()["plan"]
    assert plan["id"] == plan_id
    assert plan["status"] == "ready"
    assert plan["planner_note"] == "今天就这些"
    assert len(plan["items"]) == 3
    first = [i for i in plan["items"] if i["group_key"] == "g1" and i["is_primary"]][0]
    assert first["account_name"] == "号一"
    assert first["sources"] == [{"platform": "x", "title": "s", "url": "u"}]


def test_today_backfills_draft_id_from_pipeline_task(client):
    plan_id, item_ids = _seed_plan(client)
    from database import SessionLocal
    from models import DailyPlanItem, PipelineTask

    async def _link():
        async with SessionLocal() as db:
            pt = PipelineTask(account_id="acc1", title="撞题选题", task_ids={}, draft_id=42)
            db.add(pt)
            await db.commit()
            await db.refresh(pt)
            it = await db.get(DailyPlanItem, item_ids[0])
            it.pipeline_task_id = pt.id
            it.status = "enqueued"
            await db.commit()
    _run(_link())

    r = client.get("/api/daily-plan/today?date=2026-06-12")
    item = [i for i in r.json()["plan"]["items"] if i["id"] == item_ids[0]][0]
    assert item["draft_id"] == 42


def test_skip_toggles_and_rejects_enqueued(client):
    _, item_ids = _seed_plan(client)
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 200 and r.json()["status"] == "skipped"
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 200 and r.json()["status"] == "suggested"

    from database import SessionLocal
    from models import DailyPlanItem
    async def _enqueue_it():
        async with SessionLocal() as db:
            it = await db.get(DailyPlanItem, item_ids[2])
            it.status = "enqueued"
            await db.commit()
    _run(_enqueue_it())
    r = client.post(f"/api/daily-plan/items/{item_ids[2]}/skip")
    assert r.status_code == 400
    r = client.post("/api/daily-plan/items/99999/skip")
    assert r.status_code == 404


def test_generate_force_recreates(client, monkeypatch):
    from database import SessionLocal
    from models import PublishAccount

    async def _acc():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", daily_quota={"long": 1}))
            await db.commit()
    _run(_acc())

    class FakeKanban:
        created = []
        def __init__(self, *a, **kw): pass
        async def create_task(self, *, title, body, assignee, parents=None):
            FakeKanban.created.append(title)
            return f"t_gen_{len(FakeKanban.created)}"
    FakeKanban.created = []
    import hermes_kanban_client
    monkeypatch.setattr(hermes_kanban_client, "HermesKanbanClient", FakeKanban)

    r = client.post("/api/daily-plan/generate")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "planning"
    r2 = client.post("/api/daily-plan/generate")
    assert r2.status_code == 200
    # force 重建：旧计划被删、重新建了策划任务（SQLite 会复用 rowid，不能断言 plan_id 不同）
    assert len(FakeKanban.created) == 2

    from database import SessionLocal
    from models import DailyPlan
    from sqlalchemy import select
    async def _count():
        async with SessionLocal() as db:
            return len((await db.execute(select(DailyPlan))).scalars().all())
    assert _run(_count()) == 1


def test_generate_400_when_no_quota(client):
    r = client.post("/api/daily-plan/generate")
    assert r.status_code == 400


def test_dashboard_alert_for_ready_plan(client, monkeypatch):
    import daily_planner
    monkeypatch.setattr(daily_planner, "today_str", lambda: "2026-06-12")
    _seed_plan(client)
    r = client.get("/api/dashboard/overview")
    assert r.status_code == 200
    texts = [a["text"] for a in r.json()["alerts"]]
    assert any("今日计划已就绪，3 条待确认" in t for t in texts)
```

注：最后一个测试 `test_dashboard_alert_for_ready_plan` 属于 Task 10 的验收，现在写进来会失败——先用 `@pytest.mark.skip(reason="Task 10 实现 dashboard alert 后启用")` 标记，Task 10 再解除。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_router.py -v`
Expected: 除 skip 外全 FAIL（404 Not Found——路由不存在）

- [ ] **Step 3: 写 routers/daily_plan.py**

```python
# backend/routers/daily_plan.py
"""今日内容计划：查询 / 重新生成 / 跳过 / 入队。"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import DailyPlan, DailyPlanItem, PipelineTask, PublishAccount

router = APIRouter(prefix="/daily-plan", tags=["daily-plan"])


class ItemOut(BaseModel):
    id: int
    account_id: str
    account_name: str
    title: str
    angle: str
    reason: str
    content_type: str
    sources: list[dict]
    group_key: str
    is_primary: bool
    status: str
    pipeline_task_id: Optional[int]
    draft_id: Optional[int]


class PlanOut(BaseModel):
    id: int
    plan_date: str
    status: str
    planner_note: str
    kanban_task_id: str
    items: list[ItemOut]


class TodayOut(BaseModel):
    plan: Optional[PlanOut] = None


async def _plan_out(db: AsyncSession, plan: DailyPlan) -> PlanOut:
    items = (await db.execute(
        select(DailyPlanItem).where(DailyPlanItem.plan_id == plan.id)
        .order_by(DailyPlanItem.account_id, DailyPlanItem.id)
    )).scalars().all()

    # 读时回填 draft_id：writer save_draft 之后 PipelineTask.draft_id 才有值
    dirty = False
    for it in items:
        if it.pipeline_task_id and it.draft_id is None:
            pt = await db.get(PipelineTask, it.pipeline_task_id)
            if pt is not None and pt.draft_id:
                it.draft_id = pt.draft_id
                dirty = True
    if dirty:
        await db.commit()

    names = dict((await db.execute(
        select(PublishAccount.id, PublishAccount.name)
    )).all())
    return PlanOut(
        id=plan.id, plan_date=plan.plan_date, status=plan.status,
        planner_note=plan.planner_note, kanban_task_id=plan.kanban_task_id,
        items=[ItemOut(
            id=it.id, account_id=it.account_id,
            account_name=names.get(it.account_id, it.account_id),
            title=it.title, angle=it.angle, reason=it.reason,
            content_type=it.content_type, sources=it.sources or [],
            group_key=it.group_key, is_primary=it.is_primary, status=it.status,
            pipeline_task_id=it.pipeline_task_id, draft_id=it.draft_id,
        ) for it in items],
    )


@router.get("/today", response_model=TodayOut)
async def get_today_plan(date: Optional[str] = None, db: AsyncSession = Depends(get_db)):
    from daily_planner import today_str
    target = date or today_str()
    plan = (await db.execute(
        select(DailyPlan).where(DailyPlan.plan_date == target)
    )).scalar_one_or_none()
    if plan is None:
        return TodayOut(plan=None)
    return TodayOut(plan=await _plan_out(db, plan))


class GenerateOut(BaseModel):
    plan_id: int
    status: str


@router.post("/generate", response_model=GenerateOut)
async def generate_plan():
    """重新生成今日计划（删除当天旧计划重建，页面「重新生成」按钮）。"""
    from daily_planner import create_today_plan
    try:
        plan = await create_today_plan(force=True)
    except Exception as e:
        raise HTTPException(503, f"策划任务创建失败: {e}")
    if plan is None:
        raise HTTPException(400, "无 active 账号或所有账号 daily_quota 为空，无法生成今日计划")
    return GenerateOut(plan_id=plan.id, status=plan.status)


@router.post("/items/{item_id}/skip")
async def toggle_skip(item_id: int, db: AsyncSession = Depends(get_db)):
    """suggested ↔ skipped 互切；已入队的不可跳过。"""
    it = await db.get(DailyPlanItem, item_id)
    if it is None:
        raise HTTPException(404, "item not found")
    if it.status == "enqueued":
        raise HTTPException(400, "已入队的选题不能跳过")
    it.status = "skipped" if it.status == "suggested" else "suggested"
    await db.commit()
    return {"id": it.id, "status": it.status}
```

- [ ] **Step 4: 注册路由**

`backend/main.py:13` 的 import 列表末尾加 `, daily_plan`：

```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, writing_plans, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator, retro, materials, skills, dashboard, daily_plan
```

include_router 区域（`app.include_router(dashboard.router, prefix="/api")` 之后）加：

```python
app.include_router(daily_plan.router, prefix="/api")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_router.py -v`
Expected: 6 PASS + 1 skip（dashboard alert 测试）

- [ ] **Step 6: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/routers/daily_plan.py backend/main.py backend/tests/test_daily_plan_router.py
git commit -m "feat(daily-plan): 查询/重新生成/跳过接口 + 读时回填 draft_id"
```

---

### Task 9: 入队接口 — 撞题组去重、一稿多发

**Files:**
- Modify: `backend/routers/daily_plan.py`（追加 enqueue 端点）
- Test: `backend/tests/test_daily_plan_enqueue.py`（新建）

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_daily_plan_enqueue.py
import sys, asyncio, pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config", "schemas",
                            "hermes_kanban_client", "mcp_server", "pipeline_template",
                            "daily_planner", "logger", "scheduler")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa
    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _patch_kanban(monkeypatch):
    calls = []
    async def fake_kanban_create(title, assignee, body, parent, env):
        calls.append({"title": title, "assignee": assignee, "body": body, "parent": parent})
        return f"t_dp_{len(calls)}"
    import routers.studio as studio
    monkeypatch.setattr(studio, "_kanban_create", fake_kanban_create)
    return calls


def _seed(client):
    """plan + 3 items：g1 组（acc1 主笔 short + acc2 组员 short）+ acc1 独立 long。"""
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def _mk():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="号一", positioning="AI 观察",
                                  audience="技术人", tone="犀利"))
            db.add(PublishAccount(id="acc2", name="号二"))
            plan = DailyPlan(plan_date="2026-06-12", status="ready")
            db.add(plan)
            await db.commit()
            await db.refresh(plan)
            items = [
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="撞题选题",
                              angle="共享角度", content_type="short", group_key="g1",
                              is_primary=True,
                              sources=[{"platform": "x", "title": "原帖", "url": "https://x.com/1"}]),
                DailyPlanItem(plan_id=plan.id, account_id="acc2", title="撞题选题",
                              angle="共享角度", content_type="short", group_key="g1",
                              is_primary=False),
                DailyPlanItem(plan_id=plan.id, account_id="acc1", title="独立长文",
                              angle="长文角度", content_type="long"),
            ]
            db.add_all(items)
            await db.commit()
            return plan.id, [i.id for i in items]
    return _run(_mk())


def _items_by_id(ids):
    from database import SessionLocal
    from models import DailyPlanItem
    async def _q():
        async with SessionLocal() as db:
            return {i: await db.get(DailyPlanItem, i) for i in ids}
    return _run(_q())


def test_enqueue_dedupes_groups_and_shares_pipeline_task(client, monkeypatch):
    calls = _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)

    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["enqueued_items"] == 3
    assert data["chains"] == 2  # g1 组合并成一条链 + 独立 long 一条

    # topic_short 链 2 棒（writer/illustrator）+ topic_long 链 3 棒 = 5 个任务
    assert len(calls) == 5
    assignees = [c["assignee"] for c in calls]
    assert assignees.count("wms_editor") == 1      # 只有 long 链有 editor
    # 主笔角度与来源进了 writer body
    short_writer_body = [c["body"] for c in calls if "撞题选题" in c["title"]][0]
    assert "共享角度" in short_writer_body
    assert "https://x.com/1" in short_writer_body
    assert "account_id: acc1" in short_writer_body  # 用主笔账号画像写

    items = _items_by_id(ids)
    assert all(it.status == "enqueued" for it in items.values())
    # g1 组共享同一 pipeline_task_id；独立 long 不同
    assert items[ids[0]].pipeline_task_id == items[ids[1]].pipeline_task_id
    assert items[ids[2]].pipeline_task_id != items[ids[0]].pipeline_task_id


def test_enqueue_partial_group_uses_first_selected(client, monkeypatch):
    calls = _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    # 只选组员（主笔未选）→ 用组员账号画像建链
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": [ids[1]]})
    assert r.status_code == 200
    assert r.json()["chains"] == 1
    assert "account_id: acc2" in calls[0]["body"]
    items = _items_by_id(ids)
    assert items[ids[1]].status == "enqueued"
    assert items[ids[0]].status == "suggested"  # 未选的主笔保持原状


def test_enqueue_skips_non_suggested_and_rejects_empty(client, monkeypatch):
    _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    client.post(f"/api/daily-plan/items/{ids[2]}/skip")  # 长文标 skipped
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": [ids[2]]})
    assert r.status_code == 400  # 没有可入队条目
    r = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": []})
    assert r.status_code == 400
    r = client.post("/api/daily-plan/99999/enqueue", json={"item_ids": [1]})
    assert r.status_code == 404


def test_enqueue_twice_is_safe(client, monkeypatch):
    _patch_kanban(monkeypatch)
    plan_id, ids = _seed(client)
    r1 = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r1.status_code == 200
    r2 = client.post(f"/api/daily-plan/{plan_id}/enqueue", json={"item_ids": ids})
    assert r2.status_code == 400  # 全部已 enqueued，无可入队条目
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_enqueue.py -v`
Expected: FAIL（405/404——enqueue 路由不存在）

- [ ] **Step 3: 实现 enqueue 端点**

在 `backend/routers/daily_plan.py` 末尾追加：

```python
class EnqueueItemsIn(BaseModel):
    item_ids: list[int]


class EnqueueItemsOut(BaseModel):
    enqueued_items: int
    chains: int
    task_ids: list[str]   # 每条链第一棒的 kanban task id


@router.post("/{plan_id}/enqueue", response_model=EnqueueItemsOut)
async def enqueue_items(plan_id: int, body: EnqueueItemsIn,
                        db: AsyncSession = Depends(get_db)):
    """把勾选的计划条目入队创作链。

    撞题组（同 group_key）只建一条链：优先用主笔（is_primary）账号的画像；
    主笔未被勾选时退化为组内第一个被勾选的账号。组内所有勾选条目共享同一
    pipeline_task_id（一稿多发）。仅 suggested 状态可入队。
    """
    from routers.studio import _account_profile_full, _run_pipeline_chain
    from routers.topic_generator import _TYPE_LABEL, _WORD_RANGE

    plan = await db.get(DailyPlan, plan_id)
    if plan is None:
        raise HTTPException(404, "plan not found")
    if not body.item_ids:
        raise HTTPException(400, "item_ids 不能为空")

    items = (await db.execute(
        select(DailyPlanItem).where(DailyPlanItem.plan_id == plan_id,
                                    DailyPlanItem.id.in_(body.item_ids))
        .order_by(DailyPlanItem.id)
    )).scalars().all()
    todo = [it for it in items if it.status == "suggested"]
    if not todo:
        raise HTTPException(400, "所选条目中没有可入队的（仅 suggested 状态可入队）")

    groups: dict[str, list[DailyPlanItem]] = {}
    for it in todo:
        groups.setdefault(it.group_key or f"__solo_{it.id}", []).append(it)

    first_task_ids: list[str] = []
    chains = 0
    for members in groups.values():
        leader = next((m for m in members if m.is_primary), members[0])
        acc = await db.get(PublishAccount, leader.account_id)
        if acc is None:
            raise HTTPException(400, f"account '{leader.account_id}' not found")

        sources_md = "\n".join(
            f"- [{s.get('platform', '?')}] {s.get('title', '')} [{s.get('url', '')}]"
            for s in (leader.sources or [])
        ) or "（无参考来源）"

        ctx = {
            "title": leader.title,
            "account_id": leader.account_id,
            "account_profile": _account_profile_full(acc),
            "content_type": leader.content_type,
            "content_type_label": _TYPE_LABEL.get(leader.content_type, leader.content_type),
            "word_range": _WORD_RANGE.get(leader.content_type, ""),
            "angle": leader.angle,
            "source_posts_md": sources_md,
            "draft_id": 0,
        }
        flow = "topic_long" if leader.content_type == "long" else "topic_short"
        out = await _run_pipeline_chain(flow, ctx, account_id=leader.account_id,
                                        title=leader.title)
        chains += 1
        first_task_ids.append(out.task_id)
        for m in members:
            m.status = "enqueued"
            m.pipeline_task_id = out.pipeline_task_id
    await db.commit()

    return EnqueueItemsOut(enqueued_items=len(todo), chains=chains,
                           task_ids=first_task_ids)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_enqueue.py tests/test_daily_plan_router.py tests/test_topic_generator.py -v`
Expected: 全 PASS（+1 skip）

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/routers/daily_plan.py backend/tests/test_daily_plan_enqueue.py
git commit -m "feat(daily-plan): 入队接口——撞题组去重一稿多发，复用 topic 蓝图"
```

---

### Task 10: 工作台提醒（dashboard alert）

**Files:**
- Modify: `backend/routers/dashboard.py`（`_build_alerts` 内、`alerts.sort` 之前追加；models import 加 DailyPlan/DailyPlanItem；确认 `func` 已从 sqlalchemy 导入，没有则加）
- Test: `backend/tests/test_daily_plan_router.py`（解除 skip）

- [ ] **Step 1: 解除 Task 8 留下的 skip 标记**

删掉 `test_dashboard_alert_for_ready_plan` 上的 `@pytest.mark.skip(...)` 行。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_router.py::test_dashboard_alert_for_ready_plan -v`
Expected: FAIL（alerts 里没有今日计划条目）

- [ ] **Step 3: 改 dashboard.py**

文件顶部 models import 行追加 `DailyPlan, DailyPlanItem`；sqlalchemy import 行确认含 `func`（如 `from sqlalchemy import select, func`）。

`_build_alerts` 函数内、`alerts.sort(...)` 之前追加：

```python
    # 今日计划：就绪待确认 / 生成失败
    try:
        import daily_planner
        plan = (await db.execute(
            select(DailyPlan).where(DailyPlan.plan_date == daily_planner.today_str())
        )).scalar_one_or_none()
        if plan is not None and plan.status == "ready":
            pending = (await db.execute(
                select(func.count()).select_from(DailyPlanItem)
                .where(DailyPlanItem.plan_id == plan.id,
                       DailyPlanItem.status == "suggested")
            )).scalar_one()
            if pending:
                alerts.append(Alert(severity="info",
                                    text=f"今日计划已就绪，{pending} 条待确认",
                                    action_label="去确认", href="/daily-plan"))
        elif plan is not None and plan.status == "failed":
            alerts.append(Alert(severity="warn", text="今日计划生成失败",
                                action_label="重新生成", href="/daily-plan"))
    except Exception:
        pass
```

注意用 `import daily_planner` + `daily_planner.today_str()`（而非 from-import），让测试 monkeypatch `daily_planner.today_str` 生效。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/test_daily_plan_router.py tests/test_dashboard.py -v`
Expected: 全 PASS（dashboard 既有测试无回归）

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add backend/routers/dashboard.py backend/tests/test_daily_plan_router.py
git commit -m "feat(daily-plan): 工作台提醒——今日计划就绪/失败"
```

---

### Task 11: 前端 — API 封装 + 导航 + /daily-plan 页面

**Files:**
- Create: `wemedia-studio/lib/api/daily-plan.ts`
- Create: `wemedia-studio/app/daily-plan/page.tsx`
- Create: `wemedia-studio/app/daily-plan/DailyPlanClient.tsx`
- Modify: `wemedia-studio/components/features/Sidebar.tsx:5-27`（icon import + 导航项）

- [ ] **Step 1: lib/api/daily-plan.ts**

```typescript
import { apiFetch } from './client'

export interface PlanItemSource {
  platform: string
  title: string
  url: string
}

export interface DailyPlanItem {
  id: number
  account_id: string
  account_name: string
  title: string
  angle: string
  reason: string
  content_type: 'long' | 'short' | 'story' | 'share'
  sources: PlanItemSource[]
  group_key: string
  is_primary: boolean
  status: 'suggested' | 'skipped' | 'enqueued'
  pipeline_task_id: number | null
  draft_id: number | null
}

export interface DailyPlan {
  id: number
  plan_date: string
  status: 'planning' | 'ready' | 'failed'
  planner_note: string
  kanban_task_id: string
  items: DailyPlanItem[]
}

export interface TodayPlanResponse {
  plan: DailyPlan | null
}

export function getTodayPlan(): Promise<TodayPlanResponse> {
  return apiFetch<TodayPlanResponse>('/daily-plan/today')
}

export function generatePlan(): Promise<{ plan_id: number; status: string }> {
  return apiFetch('/daily-plan/generate', { method: 'POST' })
}

export function enqueuePlanItems(
  planId: number,
  itemIds: number[],
): Promise<{ enqueued_items: number; chains: number; task_ids: string[] }> {
  return apiFetch(`/daily-plan/${planId}/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ item_ids: itemIds }),
  })
}

export function toggleSkipItem(itemId: number): Promise<{ id: number; status: string }> {
  return apiFetch(`/daily-plan/items/${itemId}/skip`, { method: 'POST' })
}
```

- [ ] **Step 2: Sidebar 导航项**

`components/features/Sidebar.tsx` 的 lucide import 加 `CalendarCheck`（加进第 6-8 行的既有 import 大括号里），第一个 section 的 items 中「今日工作台」之后插入：

```typescript
      { href: '/daily-plan', label: '今日计划', icon: CalendarCheck },
```

- [ ] **Step 3: app/daily-plan/page.tsx**

```tsx
export const dynamic = 'force-dynamic'

import { DailyPlanClient } from './DailyPlanClient'
import { apiFetch } from '@/lib/api/client'
import type { TodayPlanResponse } from '@/lib/api/daily-plan'

export default async function DailyPlanPage() {
  const initial = await apiFetch<TodayPlanResponse>('/daily-plan/today')
    .catch(() => ({ plan: null }) as TodayPlanResponse)
  return <DailyPlanClient initialPlan={initial.plan} />
}
```

- [ ] **Step 4: app/daily-plan/DailyPlanClient.tsx**

```tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { CalendarCheck, ExternalLink, Loader2, RefreshCw, Send, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DailyPlan, DailyPlanItem, enqueuePlanItems, generatePlan, getTodayPlan, toggleSkipItem,
} from '@/lib/api/daily-plan'

const TYPE_LABEL: Record<string, string> = {
  long: '长文', short: '短文', story: '微故事', share: '发现',
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  planning: { label: '总编策划中…', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  ready:    { label: '已就绪',      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  failed:   { label: '生成失败',    cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

export function DailyPlanClient({ initialPlan }: { initialPlan: DailyPlan | null }) {
  const [plan, setPlan] = useState<DailyPlan | null>(initialPlan)
  const [selected, setSelected] = useState<Set<number>>(
    new Set((initialPlan?.items ?? []).filter(i => i.status === 'suggested').map(i => i.id)),
  )
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { plan: p } = await getTodayPlan()
      setPlan(p)
      if (p) {
        setSelected(prev => {
          const valid = new Set(p.items.filter(i => i.status === 'suggested').map(i => i.id))
          const kept = new Set([...prev].filter(id => valid.has(id)))
          return prev.size === 0 ? valid : kept
        })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    }
  }, [])

  // 策划中每 10s 轮询
  useEffect(() => {
    if (plan?.status !== 'planning') return
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [plan?.status, refresh])

  const byAccount = useMemo(() => {
    const m = new Map<string, DailyPlanItem[]>()
    for (const it of plan?.items ?? []) {
      const k = it.account_name || it.account_id
      m.set(k, [...(m.get(k) ?? []), it])
    }
    return [...m.entries()]
  }, [plan])

  async function handleGenerate() {
    setBusy(true)
    try {
      await generatePlan()
      toast.success('已发起重新生成，总编策划中…')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleEnqueue() {
    if (!plan || selected.size === 0) return
    setBusy(true)
    try {
      const r = await enqueuePlanItems(plan.id, [...selected])
      toast.success(`已入队 ${r.enqueued_items} 条（${r.chains} 条创作链）`)
      setSelected(new Set())
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '入队失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSkip(item: DailyPlanItem) {
    try {
      await toggleSkipItem(item.id)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  const badge = plan ? STATUS_BADGE[plan.status] : null

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <header className="flex items-center gap-3">
        <CalendarCheck className="w-5 h-5 text-indigo-600" />
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          今日计划{plan ? ` · ${plan.plan_date}` : ''}
        </h1>
        {badge && (
          <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', badge.cls)}>
            {plan?.status === 'planning' && <Loader2 className="inline w-3 h-3 mr-1 animate-spin" />}
            {badge.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleGenerate}
                  disabled={busy || plan?.status === 'planning'} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> 重新生成
          </Button>
          <Button size="sm" onClick={handleEnqueue}
                  disabled={busy || selected.size === 0} className="gap-1.5">
            <Send className="w-3.5 h-3.5" /> 入队所选（{selected.size}）
          </Button>
        </div>
      </header>

      {plan?.planner_note && (
        <p className="text-sm text-zinc-500 bg-zinc-100 dark:bg-zinc-900 rounded-lg px-3 py-2">
          总编留言：{plan.planner_note}
        </p>
      )}

      {!plan && (
        <div className="text-center py-20 text-zinc-400 text-sm space-y-3">
          <p>今天还没有计划。每天 8:00 自动生成，也可以现在手动生成。</p>
          <Button onClick={handleGenerate} disabled={busy}>立即生成今日计划</Button>
        </div>
      )}

      {plan?.status === 'planning' && plan.items.length === 0 && (
        <div className="text-center py-20 text-zinc-400 text-sm">
          总编正在拉取候选池、分配选题……（自动刷新中）
        </div>
      )}

      {byAccount.map(([accountName, items]) => (
        <section key={accountName} className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            <Users className="w-4 h-4" /> {accountName}
          </h2>
          <div className="space-y-2">
            {items.map(item => (
              <div key={item.id}
                   className={cn(
                     'rounded-lg border p-3 flex gap-3 bg-white dark:bg-zinc-900',
                     'border-zinc-200 dark:border-zinc-800',
                     item.status === 'skipped' && 'opacity-50',
                   )}>
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 accent-indigo-600"
                  disabled={item.status !== 'suggested'}
                  checked={selected.has(item.id)}
                  onChange={e => setSelected(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
                      {item.title}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {TYPE_LABEL[item.content_type] ?? item.content_type}
                    </span>
                    {item.group_key && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                        共享一稿{item.is_primary ? ' · 主笔' : ''}
                      </span>
                    )}
                    {item.status === 'enqueued' && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        已入队
                      </span>
                    )}
                  </div>
                  {item.angle && <p className="text-xs text-zinc-500">角度：{item.angle}</p>}
                  {item.reason && <p className="text-xs text-zinc-400">{item.reason}</p>}
                  {item.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {item.sources.map((s, i) => (
                        <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer"
                           className="inline-flex items-center gap-0.5 text-[11px] text-indigo-500 hover:underline">
                          <ExternalLink className="w-3 h-3" />
                          [{s.platform}] {s.title || s.url}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-xs shrink-0">
                  {item.status !== 'enqueued' && (
                    <button onClick={() => handleSkip(item)}
                            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                      {item.status === 'skipped' ? '恢复' : '跳过'}
                    </button>
                  )}
                  {item.draft_id && (
                    <Link href="/drafts" className="text-indigo-500 hover:underline">
                      草稿 #{item.draft_id}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 构建验证**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && pnpm build`
Expected: build 成功，无 type error（出现 `/daily-plan` 路由）

- [ ] **Step 6: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add wemedia-studio/lib/api/daily-plan.ts wemedia-studio/app/daily-plan wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat(daily-plan): 今日计划独立页——勾选入队/跳过/重新生成 + 导航项"
```

---

### Task 12: 设置页账号表单加 daily_quota

**Files:**
- Modify: `wemedia-studio/lib/api/publish-accounts.ts:14-34`（接口加字段）
- Modify: `wemedia-studio/app/settings/sections/PublishAccountsSection.tsx`（EditState/EMPTY_EDIT/accountToEdit/editToInput + 表单 UI）

- [ ] **Step 1: publish-accounts.ts**

`PublishAccount` interface 的 `word_range: Record<string, number>` 之后加：

```typescript
  daily_quota: Record<string, number>
```

（`PublishAccountInput`/`PublishAccountPatch` 是派生类型，自动带上。）

- [ ] **Step 2: PublishAccountsSection.tsx 四处对应改动**

`EditState`（`word_range_json: string` 之后）加：

```typescript
  daily_quota_json: string  // raw JSON，如 {"long":1,"short":2}；{} = 不参与每日计划
```

`EMPTY_EDIT`（`word_range_json: ...` 之后）加：

```typescript
  daily_quota_json: '{}',
```

`accountToEdit`（`word_range_json: ...` 之后）加：

```typescript
    daily_quota_json: JSON.stringify(p.daily_quota ?? {}, null, 0),
```

`editToInput` 在 word_range 解析块之后加同款解析：

```typescript
  let daily_quota: Record<string, number> = {}
  if (form.daily_quota_json.trim()) {
    try {
      const parsed = JSON.parse(form.daily_quota_json)
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        return { error: '每日配额必须是 JSON 对象（如 {"long":1,"short":2}）' }
      }
      daily_quota = parsed
    } catch {
      return { error: '每日配额 JSON 格式错误' }
    }
  }
```

并在 return 对象的 `word_range,` 之后加 `daily_quota,`。

- [ ] **Step 3: 表单 UI**

在「字数范围」的 `<div className="space-y-1">...</div>` 块之后（`PublishAccountsSection.tsx:681` 附近）加：

```tsx
      <div className="space-y-1">
        <Label className="text-xs">每日配额（daily_quota，JSON 对象）</Label>
        <p className="text-[11px] text-zinc-400">
          今日计划按此配额给账号派选题，如 <code className="font-mono">{`{"long":1,"short":2}`}</code>
          （story/share 计入 short）；留 <code className="font-mono">{`{}`}</code> 表示不参与每日计划
        </p>
        <Input
          value={form.daily_quota_json}
          onChange={e => setForm({ ...form, daily_quota_json: e.target.value })}
          placeholder='{"long":1,"short":2}'
          className="h-8 text-sm font-mono"
        />
      </div>
```

- [ ] **Step 4: 构建验证**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && pnpm build`
Expected: build 成功

- [ ] **Step 5: Commit**

```bash
cd /workspace/projects/WeMediaStudio
git add wemedia-studio/lib/api/publish-accounts.ts wemedia-studio/app/settings/sections/PublishAccountsSection.tsx
git commit -m "feat(daily-plan): 账号设置表单支持每日配额 daily_quota"
```

---

### Task 13: 全量验证 + 线上 PG 手动 ALTER

- [ ] **Step 1: 后端全量测试**

Run: `cd /workspace/projects/WeMediaStudio/backend && conda run -n wems python -m pytest tests/ -x -q --deselect tests/test_x_router.py 2>&1 | tail -20`

也可不带 `-x` 全跑后对照基线：**11 个既存失败 + 2 个 flake（x_router 网络依赖、ref_collector 顺序污染）属于基线**，只要没有新增失败即通过。本任务新增的 5 个测试文件必须全 PASS：

`conda run -n wems python -m pytest tests/test_daily_plan_models.py tests/test_pipeline_template_daily_plan.py tests/test_daily_planner.py tests/test_mcp_daily_plan_tools.py tests/test_daily_plan_router.py tests/test_daily_plan_enqueue.py -v`

- [ ] **Step 2: 前端 build**

Run: `source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && pnpm build`
Expected: 成功

- [ ] **Step 3: 提醒用户线上 PG 手动 ALTER**

新表 `daily_plans` / `daily_plan_items` 由启动时 `create_all` 自建，**不用管**；
但 `publish_accounts` 是既有表，加列必须手动执行（输出给用户，让用户在线上 PG 执行）：

```sql
ALTER TABLE publish_accounts ADD COLUMN IF NOT EXISTS daily_quota JSON DEFAULT '{}';
```

- [ ] **Step 4: 收尾**

如有未提交的零散改动一并提交；向用户汇报：完成状态、测试结果、PG ALTER 待办、
以及验证路径——给某个账号配 daily_quota → 点 /daily-plan「立即生成今日计划」→
看 kanban 出现「今日内容计划」任务（assignee wms_scout）。

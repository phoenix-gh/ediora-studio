# 长文正文配图（inline illustration）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在草稿箱按需触发一个 `wms_illustrator` 单棒任务,分析长文章节、生成内容插图、上传并插入正文,重跑幂等。

**Architecture:** 复刻现有 `cover_only` 手动单棒流程。新增纯函数 `strip_inline_illus`(幂等清理)、单棒 pipeline `illustrate_body`、端点 `POST /studio/illustrate-body`(镜像 `regenerate-cover`:先剥旧块存回再派发)。复用上个功能的 `resolve_effective_design` 取有效 image_style。前端在 `DraftAssetsDialog` 加「自动配图」动作。

**Tech Stack:** FastAPI + SQLAlchemy async + Pydantic v2(后端,conda env `wems`);Next.js + shadcn/ui(前端,pnpm)。

> 环境:后端命令加 `conda run -n wems` 前缀;Bash 先 `source ~/.zshrc`;从 `backend/` 跑 pytest。无迁移框架,但本功能**不加列**,无需 ALTER。

---

## File Structure

- `backend/pipeline_template.py` — 新增 `strip_inline_illus` 纯函数 + `INLINE_ILLUS_PIPELINE` 单棒 + 注册 `PIPELINES["illustrate_body"]`
- `backend/routers/studio.py` — 新增 `IllustrateBodyIn` + `POST /studio/illustrate-body`
- `backend/tests/test_inline_illus.py` — `strip_inline_illus` + pipeline 纯函数单测(新建)
- `backend/tests/test_studio_illustrate.py` — 端点集成测试(新建,自带 fixture)
- `wemedia-studio/lib/api/studio.ts` — `IllustrateBodyIn` + `illustrateBody()`
- `wemedia-studio/components/features/DraftAssetsDialog.tsx` — 「自动配图」按钮 + 面板 + handler

---

## Task 1: `strip_inline_illus` 纯函数（TDD）

**Files:**
- Modify: `backend/pipeline_template.py`（在 `resolve_effective_design` 之后追加）
- Test: `backend/tests/test_inline_illus.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_inline_illus.py`:

```python
from pipeline_template import strip_inline_illus


def test_removes_single_block():
    md = "前文\n\n<!-- wms-illus -->\n![图](u.png)\n<!-- /wms-illus -->\n\n后文"
    assert strip_inline_illus(md) == "前文\n\n后文"


def test_removes_multiple_blocks():
    md = ("a\n\n<!-- wms-illus -->\n![](1.png)\n<!-- /wms-illus -->\n\n"
          "b\n\n<!-- wms-illus -->\n![](2.png)\n<!-- /wms-illus -->\n\nc")
    assert strip_inline_illus(md) == "a\n\nb\n\nc"


def test_no_marker_returns_identical():
    md = "纯正文\n\n第二段\n"   # 含末尾换行也不动
    assert strip_inline_illus(md) == md


def test_keeps_handwritten_images():
    md = "见图 ![手写](manual.png) 这里\n\n<!-- wms-illus -->\n![](auto.png)\n<!-- /wms-illus -->"
    assert strip_inline_illus(md) == "见图 ![手写](manual.png) 这里"


def test_empty():
    assert strip_inline_illus("") == ""
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_inline_illus.py -q`
Expected: FAIL — `ImportError: cannot import name 'strip_inline_illus'`。

- [ ] **Step 3: 实现函数**

`backend/pipeline_template.py`,在 `resolve_effective_design` 函数之后追加:

```python
_INLINE_ILLUS_RE = re.compile(r"<!-- wms-illus -->.*?<!-- /wms-illus -->", re.S)


def strip_inline_illus(md: str) -> str:
    """剥掉所有 <!-- wms-illus -->...<!-- /wms-illus --> 块（系统自动插入的正文配图），
    折叠残留空行。无标记时原样返回（保留末尾换行等）。"""
    if not md or "<!-- wms-illus -->" not in md:
        return md
    out = _INLINE_ILLUS_RE.sub("", md)
    return re.sub(r"\n{3,}", "\n\n", out).strip()
```

（`re` 已在文件顶部 import。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_inline_illus.py -q`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_inline_illus.py
git commit -m "feat(pipeline): add strip_inline_illus idempotency helper"
```

---

## Task 2: `illustrate_body` 单棒 pipeline（TDD）

**Files:**
- Modify: `backend/pipeline_template.py`（`REWRITE_ONLY_PIPELINE` 之后、`PIPELINES` 之前加 step;并在 `PIPELINES` dict 注册）
- Test: `backend/tests/test_inline_illus.py`（追加）

- [ ] **Step 1: 写失败测试**

追加到 `backend/tests/test_inline_illus.py`:

```python
def test_illustrate_body_pipeline_registered():
    from pipeline_template import get_pipeline
    steps = get_pipeline("illustrate_body")
    assert len(steps) == 1
    assert steps[0].assignee == "wms_illustrator"


def test_illustrate_body_body_has_guardrail_marker_and_style():
    from pipeline_template import get_pipeline
    step = get_pipeline("illustrate_body")[0]
    ctx = {"draft_id": 7, "account_id": "a",
           "account_profile": {"image_style": "扁平插画"}, "max_images": 3, "note": ""}
    body = step.body(ctx)
    assert "≤ 3 个" in body
    assert "<!-- wms-illus -->" in body
    assert "扁平插画" in body
    assert "draft #7" in step.title(ctx)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_inline_illus.py -k illustrate_body -q`
Expected: FAIL — `ValueError: unknown flow 'illustrate_body'`。

- [ ] **Step 3: 实现 pipeline**

`backend/pipeline_template.py`,在 `REWRITE_ONLY_PIPELINE = [...]` 块结束之后、`PIPELINES = {...}` 之前插入:

```python
# ── illustrate_body：正文配图，用户在草稿箱手动触发的单棒 ──────────────
# 服务端在派发前已用 strip_inline_illus 清掉上一轮自动插图，agent 在干净正文上插新图。
INLINE_ILLUS_PIPELINE: list[PipelineStep] = [
    PipelineStep(
        role="illustrator",
        assignee="wms_illustrator",
        title=lambda c: f"正文配图：draft #{c['draft_id']}",
        body=lambda c: f"""flow: illustrate_body
draft_id: {c['draft_id']}
account_id: {c['account_id']}

## 视觉约束
- image_style: {c['account_profile'].get('image_style') or '（未填，自由发挥）'}

## 这棒任务（illustrator · 正文配图，单棒交付）
`get_draft({c['draft_id']})` 读正文（系统已清掉上一轮自动插图，正文是干净的）。

1. 分析正文的 H2 小节 / 段落结构，在**小节边界**挑 **≤ {c['max_images']} 个**插图点：
   - 只在内容值得配图的小节配；短小节、过渡段可不配；不要为凑数硬配。
   - 插图点落在小节之间，**绝不插在句子或段落中间**。
2. 每个插图点：按 `image_style` + 该小节主题，调 `baoyu-cover-image` 技能生成**内容插图**：
   - **不套封面 cover_style 模板、不放标题文字**；aspect_ratio 默认 16:9；以内容相关性与视觉吸引力为先。
   - 生成失败就**跳过该点继续**，不要整体中断。
   - 得到本地路径后 `upload_image_from_path(path=<本地路径>, filename_hint='illus.png', draft_id={c['draft_id']})` 拿 `hosted_url`。
3. 组装新正文：每张图在选定边界插入，**必须逐字裹注释壳**（用于幂等重跑）：

<!-- wms-illus -->
![<一句话 alt，描述图意>](<hosted_url>)
<!-- /wms-illus -->

4. **一次** `update_draft(draft_id={c['draft_id']}, content=<带配图的完整新正文>)`（不要多次 patch）。
{_inline_illus_note_md(c)}
一张都没成才 `kanban_block(reason='正文配图失败: <err>')`。
完成：`kanban_complete(summary='正文配图 N 张', metadata={{"draft_id": {c['draft_id']}, "image_count": N}})`
""".strip(),
    ),
]
```

并在该 step 之前加一个小 helper（避免 f-string 内嵌条件表达式的引号问题，沿用文件既有 `_render_*` helper 风格）:

```python
def _inline_illus_note_md(c: RenderCtx) -> str:
    return f"5. 用户备注（必读）：{c['note']}\n" if c.get("note") else ""
```

然后在 `PIPELINES` dict 里注册（`"rewrite_only"` 行后加一行）:

```python
    "illustrate_body": INLINE_ILLUS_PIPELINE,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_inline_illus.py -q`
Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_inline_illus.py
git commit -m "feat(pipeline): add illustrate_body single-step pipeline"
```

---

## Task 3: `POST /studio/illustrate-body` 端点（TDD）

**Files:**
- Modify: `backend/routers/studio.py`（在 `regenerate_cover` 端点之后追加）
- Test: `backend/tests/test_studio_illustrate.py`（新建，自带 fixture）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_studio_illustrate.py`:

```python
import sys
import asyncio
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "schemas", "hermes_kanban_client", "mcp_server", "pipeline_template")):
            sys.modules.pop(mod, None)
    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())
    from main import app
    return TestClient(app)


def test_illustrate_body_strips_old_and_dispatches(client, monkeypatch):
    captured = {}

    async def fake_kanban_create(title, assignee, body, parent, env):
        captured["body"] = body
        captured["assignee"] = assignee
        return "t_illus_1"

    import routers.studio as studio
    monkeypatch.setattr(studio, "_kanban_create", fake_kanban_create)

    from database import SessionLocal
    from models import PublishAccount, ArticleDraft

    async def _seed():
        async with SessionLocal() as db:
            db.add(PublishAccount(id="acc1", name="A", platform="wechat", image_style="账号插画"))
            db.add(ArticleDraft(
                id=10, topic_id="agent", title="T",
                content="正文\n\n<!-- wms-illus -->\n![old](old.png)\n<!-- /wms-illus -->\n\n尾",
            ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    r = client.post("/api/studio/illustrate-body", json={
        "draft_id": 10, "account_id": "acc1", "max_images": 2,
    })
    assert r.status_code == 200, r.text
    assert r.json()["task_id"] == "t_illus_1"
    assert captured["assignee"] == "wms_illustrator"
    assert "≤ 2 个" in captured["body"]
    assert "账号插画" in captured["body"]

    async def _check():
        async with SessionLocal() as db:
            d = await db.get(ArticleDraft, 10)
            return d.content
    content = asyncio.new_event_loop().run_until_complete(_check())
    assert "old.png" not in content      # 旧自动插图已剥
    assert content == "正文\n\n尾"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_studio_illustrate.py -q`
Expected: FAIL — 404/422（端点不存在）。

- [ ] **Step 3: 实现端点**

`backend/routers/studio.py`,在 `regenerate_cover` 函数（以 `return EnqueueOut(task_id=task_id)` 结束）之后追加:

```python
class IllustrateBodyIn(BaseModel):
    draft_id: int
    account_id: str
    max_images: int = 4
    note: str = ""
    image_style: str | None = None


@router.post("/illustrate-body", response_model=EnqueueOut)
async def illustrate_body(payload: IllustrateBodyIn):
    """Spawn a wms_illustrator task to analyze a draft's sections and insert
    inline illustrations. Idempotent: strips previously auto-inserted images
    (wms-illus marked) from the body before dispatching."""
    if not payload.account_id.strip():
        raise HTTPException(400, "account_id is required")
    if payload.draft_id <= 0:
        raise HTTPException(400, "draft_id is required")

    from database import SessionLocal
    from models import ArticleDraft, PipelineTask, PublishAccount, WritingPlan
    from pipeline_template import get_pipeline, strip_inline_illus, resolve_effective_design
    from sqlalchemy import select as sa_select

    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, payload.draft_id)
        if draft is None:
            raise HTTPException(404, f"draft #{payload.draft_id} not found")
        acc = await db.get(PublishAccount, payload.account_id)
        if acc is None:
            raise HTTPException(400, f"account '{payload.account_id}' not found")
        plan = await db.get(WritingPlan, draft.writing_plan_id) if draft.writing_plan_id else None
        res = await db.execute(
            sa_select(PipelineTask).where(PipelineTask.draft_id == payload.draft_id).limit(1)
        )
        pt = res.scalar_one_or_none()

        # 幂等：派发前先剥旧块、存回干净正文
        draft.content = strip_inline_illus(draft.content or "")
        await db.commit()

    _, eff_image = resolve_effective_design(
        acc.cover_style or {}, acc.image_style,
        (plan.cover_style if plan else {}) or {}, (plan.image_style if plan else "") or "",
        None, payload.image_style,
    )

    parent_task_id: Optional[str] = None
    if pt is not None:
        ids = pt.task_ids or {}
        parent_task_id = ids.get("writer") or ids.get("editor")

    ctx = {
        "draft_id": payload.draft_id,
        "account_id": payload.account_id,
        "account_profile": {"name": acc.name, "platform": acc.platform, "image_style": eff_image},
        "max_images": payload.max_images,
        "note": payload.note or "",
    }
    step = get_pipeline("illustrate_body")[0]
    env = {**os.environ, "HERMES_KANBAN_BOARD": _KANBAN_BOARD}
    task_id = await _kanban_create(
        title=step.title(ctx), assignee=step.assignee, body=step.body(ctx),
        parent=parent_task_id, env=env,
    )
    await _append_pipeline_extra(payload.draft_id, "illustrator", task_id)
    _cache["data"] = None
    return EnqueueOut(task_id=task_id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_studio_illustrate.py -q`
Expected: 1 passed。

- [ ] **Step 5: 跑相关后端测试防回归**

Run: `cd backend && conda run -n wems pytest tests/test_inline_illus.py tests/test_studio_illustrate.py tests/test_writing_plans.py tests/test_pipeline_template_topic.py -q`
Expected: 全部 passed。

- [ ] **Step 6: Commit**

```bash
git add backend/routers/studio.py backend/tests/test_studio_illustrate.py
git commit -m "feat(studio): POST /studio/illustrate-body inline illustration endpoint"
```

---

## Task 4: 前端 API 客户端

**Files:**
- Modify: `wemedia-studio/lib/api/studio.ts`

> 前端无 JS 测试框架,Task 4-5 用 `tsc --noEmit` + 手动验证。

- [ ] **Step 1: 加 `IllustrateBodyIn` + `illustrateBody()`**

`wemedia-studio/lib/api/studio.ts`,在 `regenerateCover`（以 `}` 结束）之后插入:

```ts
export interface IllustrateBodyIn {
  draft_id: number
  account_id: string
  max_images?: number
  note?: string
  image_style?: string
}

export async function illustrateBody(body: IllustrateBodyIn): Promise<{ task_id: string }> {
  return apiFetch('/studio/illustrate-body', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 2: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错。

- [ ] **Step 3: Commit**

```bash
git add wemedia-studio/lib/api/studio.ts
git commit -m "feat(ui-api): illustrateBody client"
```

---

## Task 5: `DraftAssetsDialog` 「自动配图」动作

**Files:**
- Modify: `wemedia-studio/components/features/DraftAssetsDialog.tsx`

镜像现有封面重生成(`regenOpen` / `handleRegen`,`:64-135`、`:227-309`)。

- [ ] **Step 1: import `illustrateBody`**

`:17` 的 `import { regenerateCover } from "@/lib/api/studio"` 改为:

```ts
import { regenerateCover, illustrateBody } from "@/lib/api/studio"
```

- [ ] **Step 2: 加 state（`:71` 之后）**

```ts
  // Inline illustration state
  const [illusOpen, setIllusOpen] = useState(false)
  const [illusMax, setIllusMax] = useState(4)
  const [illusNote, setIllusNote] = useState("")
  const [illusBusy, setIllusBusy] = useState(false)
```

- [ ] **Step 3: 账号加载 effect 也覆盖 illusOpen（`:77-82`）**

把:
```ts
  useEffect(() => {
    if (!regenOpen || accounts) return
    listPublishAccounts()
      .then(list => setAccounts(list.filter(a => a.is_active)))
      .catch(() => toast.error("加载发布账号失败"))
  }, [regenOpen, accounts])
```
改为:
```ts
  useEffect(() => {
    if ((!regenOpen && !illusOpen) || accounts) return
    listPublishAccounts()
      .then(list => setAccounts(list.filter(a => a.is_active)))
      .catch(() => toast.error("加载发布账号失败"))
  }, [regenOpen, illusOpen, accounts])
```

- [ ] **Step 4: 加 handler（`handleRegen` 之后）**

```ts
  async function handleIllustrate() {
    if (!accountId) { toast.error("请选择发布账号"); return }
    setIllusBusy(true)
    try {
      const res = await illustrateBody({
        draft_id: draftId,
        account_id: accountId,
        max_images: illusMax,
        note: illusNote || undefined,
      })
      toast.success(`已派 illustrator 正文配图 · ${res.task_id}`)
      setIllusOpen(false)
      setIllusNote("")
      setTimeout(onRefreshImages, 5000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "派单失败")
    } finally {
      setIllusBusy(false)
    }
  }
```

- [ ] **Step 5: 加「自动配图」按钮 + 面板**

在封面按钮（`:227-233` 的 `<button onClick={() => setRegenOpen(v => !v)} ...>` 整段)**之后**插入一个并列按钮:

```tsx
                  <button
                    onClick={() => setIllusOpen(v => !v)}
                    className="flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300 transition-colors"
                  >
                    <Sparkles className="w-3 h-3" />
                    自动配图
                  </button>
```

在 `regenOpen` 面板（`:259` 起的 `{regenOpen && (...)}` 整块)**之后**插入配图面板:

```tsx
                {illusOpen && (
                  <div className="mt-2 p-3 border border-zinc-200 dark:border-zinc-800 rounded-md bg-zinc-50 dark:bg-zinc-900 space-y-2">
                    <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                      让 illustrator 分析章节，给正文插图（重跑会先清掉上一轮自动插图）
                    </div>
                    <div>
                      <div className="text-xs font-medium text-zinc-500 mb-1.5">发布账号</div>
                      <select
                        value={accountId ?? ""}
                        onChange={e => setAccountId(e.target.value || null)}
                        className="w-full text-xs px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-950 outline-none focus:border-violet-400 text-zinc-700 dark:text-zinc-300"
                      >
                        <option value="">（选择账号）</option>
                        {(accounts ?? []).map(a => (
                          <option key={a.id} value={a.id}>{a.name}（{a.platform}）</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">最多插图</span>
                      <input
                        type="number" min={1} max={12} value={illusMax}
                        onChange={e => setIllusMax(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                        className="w-16 text-xs px-2 py-1 border border-zinc-200 dark:border-zinc-700 rounded bg-white dark:bg-zinc-950 outline-none focus:border-violet-400"
                      />
                      <span className="text-[10px] text-zinc-400">张（护栏，agent 在此上限内按内容决定）</span>
                    </div>
                    <Input
                      placeholder="额外指令（可选），比如「偏插画、少用照片」"
                      value={illusNote}
                      onChange={e => setIllusNote(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <div className="flex justify-end">
                      <Button size="sm" onClick={handleIllustrate} disabled={illusBusy || !accountId} className="gap-1">
                        {illusBusy && <Loader2 className="w-3 h-3 animate-spin" />} 开始配图
                      </Button>
                    </div>
                  </div>
                )}
```

> 注:确认 `Input`、`Loader2`、`Sparkles`、`Button` 已在本文件 import(`Button`/`Loader2`/`Sparkles` 已用;若 `Input` 未 import,从 `@/components/ui/input` 补:`import { Input } from "@/components/ui/input"`)。

- [ ] **Step 6: 类型检查 + 手动验证**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错。
手动:草稿箱打开某长文的图片/素材弹窗 → 点「自动配图」→ 选账号、设最多 3 张、填备注 → 开始配图 → toast 给出 task_id。后端日志看到 `wms_illustrator` 任务 body 含「≤ 3 个」和 wms-illus 壳说明;若该 draft 正文原有 wms-illus 旧块,DB 里已被剥除。

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/components/features/DraftAssetsDialog.tsx
git commit -m "feat(ui): 自动配图 action in DraftAssetsDialog"
```

---

## 收尾验证

- [ ] 后端:`cd backend && conda run -n wems pytest tests/test_inline_illus.py tests/test_studio_illustrate.py tests/test_writing_plans.py tests/test_pipeline_template_topic.py -q` → 全绿
- [ ] 前端类型:`cd wemedia-studio && pnpm exec tsc --noEmit` → 无错
- [ ] 端到端手测:对一篇含/不含旧自动插图的长文触发「自动配图」,确认(a)旧块被剥、(b)新任务派出、(c)重复触发不会越堆越多

## Self-Review 备注（已核对）

- **Spec 覆盖**:①标记约定=Task2 body+Task1;②`strip_inline_illus`=Task1;③端点=Task3;④pipeline=Task2;⑤前端=Task4-5;image_style 合并=Task3(复用 `resolve_effective_design`)。全覆盖。
- **类型一致**:`strip_inline_illus(md)->str` Task1 定义、Task3 调用一致;flow 名 `"illustrate_body"` Task2 注册、Task3 `get_pipeline` 调用一致;`illustrateBody`/`IllustrateBodyIn` Task4 定义、Task5 调用一致;ctx 键(`draft_id/account_id/account_profile/max_images/note`)Task2 body 读取、Task3 构造一致。
- **范围**:不进自动链路、不清图库孤儿、不做短文门槛(spec 已声明)。

# 写作方案 创作目标与设计覆盖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `WritingPlan` 携带可覆盖账号默认的 `cover_style`/`image_style`,并让 `dispatch_plan` 在派发时拍板本次 `angle`/`draft_type`/临时设计覆盖,按 账号<方案<本次 三层 merge 喂给 editor→writer→illustrator 链路。

**Architecture:** 长短文继续由方案 `brief` 的 `word_spec` 隐式决定(A 路线,不动)。新增纯函数 `resolve_effective_design` 做三层合并;`dispatch_plan` 用它替换直读 `account.cover_style`;新增字段透传到已有 pipeline 模板(illustrator 已消费 cover_style/image_style,writer 已消费 word_spec)。`save_draft` 增加 `draft_type` 透传打标。

**Tech Stack:** FastAPI + SQLAlchemy async + Pydantic v2(后端,conda env `wems`);Next.js + shadcn/ui(前端,pnpm)。

> 环境:所有后端命令加 `conda run -n wems` 前缀;Bash 先 `source ~/.zshrc`。无迁移框架,线上 Postgres 需手动 ALTER(测试库 `create_all` 自动建列)。

---

## File Structure

- `backend/models.py` — `WritingPlan` 加 `cover_style`/`image_style`;`PipelineTask` 加 `goal`
- `backend/schemas.py` — `WritingPlanCreate/Update/Out` 加设计字段;`DispatchPlanRequest` 加目标字段
- `backend/routers/writing_plans.py` — `create_plan` 持久化新字段;`dispatch_plan` 用 merge + angle + draft_type + goal
- `backend/pipeline_template.py` — 新增 `resolve_effective_design`;writer body 透传 `draft_type`
- `backend/mcp_server.py` — `save_draft` 加 `draft_type` 参数
- `backend/tests/test_design_merge.py` — `resolve_effective_design` 单测(新建)
- `backend/tests/test_writing_plans.py` — dispatch merge / angle / goal 集成测试(追加)
- `wemedia-studio/lib/api/writing-plans.ts` — 接口与 `dispatchPlan` 签名
- `wemedia-studio/app/writing-plans/WritingPlansClient.tsx` — 方案编辑加 CoverStyleEditor;派发加 angle/draft_type/override

---

## Task 1: 模型字段(WritingPlan + PipelineTask)

**Files:**
- Modify: `backend/models.py:291`(WritingPlan)、`backend/models.py:370`(PipelineTask)

- [ ] **Step 1: 给 WritingPlan 加两个覆盖字段**

在 `backend/models.py` 的 `WritingPlan` 类里,`status` 字段后、`created_at` 前插入:

```python
    cover_style: Mapped[dict] = mapped_column(JSON, default=dict)
    image_style: Mapped[str] = mapped_column(Text, default="")
```

(`JSON` 与 `Text` 已在文件顶部 import,无需新增。)

- [ ] **Step 2: 给 PipelineTask 加 goal 列**

在 `PipelineTask` 类里 `task_ids` 字段后插入:

```python
    goal: Mapped[dict] = mapped_column(JSON, default=dict)  # {angle, draft_type}
```

- [ ] **Step 3: 验证模型可导入**

Run: `cd backend && conda run -n wems python -c "import models; print(models.WritingPlan.cover_style, models.PipelineTask.goal)"`
Expected: 打印两个 InstrumentedAttribute,无报错。

- [ ] **Step 4: 写线上 ALTER 备注(不执行)**

在 commit message 里记录线上需手动执行(本地测试库 `create_all` 自动建列,无需现在跑):

```sql
ALTER TABLE writing_plans ADD COLUMN cover_style JSON DEFAULT '{}'::json;
ALTER TABLE writing_plans ADD COLUMN image_style TEXT DEFAULT '';
ALTER TABLE pipeline_tasks ADD COLUMN goal JSON DEFAULT '{}'::json;
```

- [ ] **Step 5: Commit**

```bash
git add backend/models.py
git commit -m "feat(model): add cover_style/image_style to WritingPlan, goal to PipelineTask

Prod migration (run manually):
  ALTER TABLE writing_plans ADD COLUMN cover_style JSON DEFAULT '{}'::json;
  ALTER TABLE writing_plans ADD COLUMN image_style TEXT DEFAULT '';
  ALTER TABLE pipeline_tasks ADD COLUMN goal JSON DEFAULT '{}'::json;"
```

---

## Task 2: Pydantic schema 扩展

**Files:**
- Modify: `backend/schemas.py:265`（Create）、`:272`（Update）、`:304`（Out）、`:331`（DispatchPlanRequest）

- [ ] **Step 1: WritingPlanCreate 加设计字段**

`backend/schemas.py` 的 `WritingPlanCreate`,在 `priority: int = 3` 后加:

```python
    cover_style: dict = {}
    image_style: str = ""
```

- [ ] **Step 2: WritingPlanUpdate 加设计字段**

`WritingPlanUpdate`,在 `status: Optional[str] = None` 后加:

```python
    cover_style: Optional[dict] = None
    image_style: Optional[str] = None
```

- [ ] **Step 3: WritingPlanOut 加设计字段**

`WritingPlanOut`,在 `updated_at: datetime` 后加:

```python
    cover_style: dict = {}
    image_style: str = ""
```

（`model_config = {"from_attributes": True}` 已在,`_enrich_plans` 的 `model_validate(p)` 会自动带出。）

- [ ] **Step 4: DispatchPlanRequest 加目标字段**

`DispatchPlanRequest` 改为:

```python
class DispatchPlanRequest(BaseModel):
    account_id: Optional[str] = None
    angle: Optional[str] = None
    draft_type: str = "article"
    cover_style: Optional[dict] = None
    image_style: Optional[str] = None
```

- [ ] **Step 5: 验证导入**

Run: `cd backend && conda run -n wems python -c "import schemas; print(schemas.DispatchPlanRequest.model_fields.keys())"`
Expected: 含 `angle, draft_type, cover_style, image_style`。

- [ ] **Step 6: create_plan 持久化新字段**

`backend/routers/writing_plans.py` 的 `create_plan`(`:202`),把 `WritingPlan(...)` 构造改为:

```python
    obj = WritingPlan(
        title=body.title,
        brief=body.brief,
        priority=body.priority,
        cover_style=body.cover_style,
        image_style=body.image_style,
    )
```

（`update_plan` 用 `body.model_dump(exclude_none=True, ...)` + `setattr`,新字段自动生效,无需改。）

- [ ] **Step 7: Commit**

```bash
git add backend/schemas.py backend/routers/writing_plans.py
git commit -m "feat(schema): plan design-override fields + dispatch goal fields"
```

---

## Task 3: 设计合并纯函数 `resolve_effective_design`(TDD)

**Files:**
- Modify: `backend/pipeline_template.py`(在 `parse_word_spec` 之后追加)
- Test: `backend/tests/test_design_merge.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_design_merge.py`:

```python
from pipeline_template import resolve_effective_design


def test_plan_overrides_one_account_cover_key():
    cover, image = resolve_effective_design(
        {"type": "hero", "palette": "warm"}, "acc-img",
        {"palette": "cool"}, "",
    )
    assert cover == {"type": "hero", "palette": "cool"}
    assert image == "acc-img"


def test_task_overrides_plan_and_account():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc",
        {"type": "scene"}, "plan-img",
        {"type": "minimal"}, "task-img",
    )
    assert cover["type"] == "minimal"
    assert image == "task-img"


def test_empty_layers_fall_through():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc", {}, "", None, None,
    )
    assert cover == {"type": "hero"}
    assert image == "acc"


def test_empty_string_does_not_override():
    cover, image = resolve_effective_design(
        {"type": "hero"}, "acc",
        {"type": ""}, "",   # 空值不覆盖
    )
    assert cover["type"] == "hero"
    assert image == "acc"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_design_merge.py -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_effective_design'`。

- [ ] **Step 3: 实现函数**

`backend/pipeline_template.py`,在 `parse_word_spec`(`:267` 结束)之后追加:

```python
def resolve_effective_design(
    account_cover: dict | None, account_image: str,
    plan_cover: dict | None, plan_image: str,
    task_cover: dict | None = None, task_image: str | None = None,
) -> tuple[dict, str]:
    """Merge cover_style / image_style across account < plan < task layers.

    cover_style: per-key overlay — 高层的非空值逐键覆盖低层(空 dict / 空值不动)。
    image_style: 取 task > plan > account 第一个非空字符串。
    """
    cover: dict = dict(account_cover or {})
    for layer in (plan_cover, task_cover):
        for k, v in (layer or {}).items():
            if v not in (None, "", [], {}):
                cover[k] = v
    image = next((s for s in (task_image, plan_image, account_image) if s), "")
    return cover, image
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_design_merge.py -v`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline_template.py backend/tests/test_design_merge.py
git commit -m "feat(pipeline): add resolve_effective_design 3-layer merge"
```

---

## Task 4: dispatch_plan 应用 merge + angle + draft_type + goal(TDD)

**Files:**
- Modify: `backend/routers/writing_plans.py:271`（dispatch_plan）
- Test: `backend/tests/test_writing_plans.py`（追加)

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_writing_plans.py` 末尾追加(沿用文件已有 `client` fixture 与 `SessionLocal` 直插模式):

```python
def test_dispatch_merges_plan_design_and_records_goal(client, monkeypatch):
    import asyncio
    captured = {}

    async def fake_create_task(self, title, body, assignee, parents=None):
        captured.setdefault("bodies", []).append(body)
        return f"t_{assignee}"

    from hermes_kanban_client import HermesKanbanClient
    monkeypatch.setattr(HermesKanbanClient, "create_task", fake_create_task)

    from database import SessionLocal
    from models import PublishAccount, WritingPlan

    async def _seed():
        async with SessionLocal() as db:
            db.add(PublishAccount(
                id="acc1", name="A", platform="wechat",
                cover_style={"type": "hero", "palette": "warm"},
                image_style="account-illust",
            ))
            db.add(WritingPlan(
                id=1, title="P", brief="写作模式:100-200字短文案",
                cover_style={"palette": "cool"}, image_style="",
            ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    r = client.post("/api/writing-plans/1/dispatch", json={
        "account_id": "acc1",
        "angle": "聚焦反差",
        "draft_type": "article",
        "cover_style": {"type": "minimal"},
    })
    assert r.status_code == 200

    illustrator_body = captured["bodies"][2]
    assert '"palette": "cool"' in illustrator_body   # plan 覆盖 account
    assert '"type": "minimal"' in illustrator_body    # request 覆盖 plan
    editor_body = captured["bodies"][0]
    assert "聚焦反差" in editor_body                    # angle 注入

    # goal 落库
    async def _check():
        async with SessionLocal() as db:
            from sqlalchemy import select
            from models import PipelineTask
            pt = (await db.execute(select(PipelineTask))).scalars().first()
            return pt.goal
    goal = asyncio.new_event_loop().run_until_complete(_check())
    assert goal["angle"] == "聚焦反差"
    assert goal["draft_type"] == "article"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_dispatch_merges_plan_design_and_records_goal -v`
Expected: FAIL —`"palette": "cool"` 不在 body(现在直读 account)且 goal 为空 `{}`。

- [ ] **Step 3: 改 dispatch_plan**

`backend/routers/writing_plans.py`:

(a) import 增补 `resolve_effective_design`,把 `:304` 的
```python
    from pipeline_template import render_profile_editor, parse_word_spec, FULL_PIPELINE
```
改成:
```python
    from pipeline_template import (
        render_profile_editor, parse_word_spec, FULL_PIPELINE, resolve_effective_design,
    )
```

(b) profile 的设计字段改用 merge。把 `:287-294` 的 `profile = {...}` 块里
```python
            "image_style": account.image_style, "cover_style": account.cover_style or {},
```
这一行替换为(并在 `profile` 赋值后补 merge):
```python
            "image_style": account.image_style, "cover_style": account.cover_style or {},
        }
    eff_cover, eff_image = resolve_effective_design(
        account.cover_style if account else {}, account.image_style if account else "",
        obj.cover_style, obj.image_style,
        body.cover_style, body.image_style,
    )
    if profile:
        profile["cover_style"] = eff_cover
        profile["image_style"] = eff_image
```
（注意:保留原 `profile = {...}` 结尾的 `}`,上面片段从该 `}` 续写。）

(c) angle 注入 editor body。在 editor body 组装处(`:333` 「## 这棒任务（editor）」块之前)插入:
```python
    if body.angle:
        editor_body_parts.extend([
            "## 本次角度（用户指定，直接用，不要重新推导）",
            body.angle,
            "",
        ])
```

(d) draft_type 进 ctx。把 `:358` 的 `ctx = {...}` 加一行:
```python
        "draft_type": body.draft_type,
```

(e) goal 落库。把 `:392` 的
```python
    pt.task_ids = {"editor": editor_id, "writer": writer_id, "illustrator": illus_id}
    await db.commit()
```
改为:
```python
    pt.task_ids = {"editor": editor_id, "writer": writer_id, "illustrator": illus_id}
    pt.goal = {"angle": body.angle or "", "draft_type": body.draft_type}
    await db.commit()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_dispatch_merges_plan_design_and_records_goal -v`
Expected: PASS。

- [ ] **Step 5: 跑整个方案测试文件防回归**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py -q`
Expected: 全部 passed。

- [ ] **Step 6: Commit**

```bash
git add backend/routers/writing_plans.py backend/tests/test_writing_plans.py
git commit -m "feat(dispatch): merge plan/task design override, inject angle, record goal"
```

---

## Task 5: save_draft 透传 draft_type(TDD)

**Files:**
- Modify: `backend/mcp_server.py:980`（save_draft）、`backend/pipeline_template.py:372`（writer body 示例）
- Test: `backend/tests/test_writing_plans.py`（追加)

- [ ] **Step 1: 写失败测试**

追加到 `backend/tests/test_writing_plans.py`:

```python
def test_save_draft_sets_draft_type(client):
    import asyncio
    from mcp_server import save_draft
    from database import SessionLocal
    from sqlalchemy import select
    from models import ArticleDraft

    async def _run():
        await save_draft(title="脚本稿", content="...", draft_type="script")
        async with SessionLocal() as db:
            d = (await db.execute(
                select(ArticleDraft).where(ArticleDraft.title == "脚本稿")
            )).scalars().first()
            return d.draft_type
    assert asyncio.new_event_loop().run_until_complete(_run()) == "script"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_save_draft_sets_draft_type -v`
Expected: FAIL — `save_draft() got an unexpected keyword argument 'draft_type'`。

- [ ] **Step 3: 给 save_draft 加参数**

`backend/mcp_server.py:980`,函数签名 `pipeline_task_id` 后加 `draft_type` 参数:

```python
async def save_draft(
    title: str,
    content: str,
    topic_id: str = "agent",
    status: str = "drafting",
    pipeline_task_id: Optional[int] = None,
    draft_type: str = "article",
) -> dict:
```

并在 `ArticleDraft(...)` 构造里加 `draft_type=draft_type`（构造体在 `:1003` 起的 `obj = ArticleDraft(topic_id=topic_id, ...)` 中追加该 kwarg）。docstring 补一行 `draft_type: "article"（默认）或 "script"。`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && conda run -n wems pytest tests/test_writing_plans.py::test_save_draft_sets_draft_type -v`
Expected: PASS。

- [ ] **Step 5: writer body 透传 draft_type 提示**

`backend/pipeline_template.py` 的 `FULL_PIPELINE[1]`(writer)body,把 `:372` 的 save_draft 示例:
```python
2. `save_draft(title, content, topic_id='agent', status='drafting', pipeline_task_id={c['pipeline_task_id']})` 拿 `draft_id`
```
改为:
```python
2. `save_draft(title, content, topic_id='agent', status='drafting', pipeline_task_id={c['pipeline_task_id']}, draft_type='{c.get('draft_type', 'article')}')` 拿 `draft_id`
```

- [ ] **Step 6: 跑 pipeline 模板既有测试防回归**

Run: `cd backend && conda run -n wems pytest tests/test_pipeline_template_topic.py -q`
Expected: 全部 passed(若该文件断言 writer body 文本需相应更新)。

- [ ] **Step 7: Commit**

```bash
git add backend/mcp_server.py backend/pipeline_template.py backend/tests/test_writing_plans.py
git commit -m "feat(draft): pass draft_type through save_draft + writer body"
```

---

## Task 6: 前端 API 客户端

**Files:**
- Modify: `wemedia-studio/lib/api/writing-plans.ts`

> 提示:本仓库前端无 JS 测试框架,Task 6-8 用类型检查 + 手动验证;改动遵循文件既有写法。改 Next 前若涉新 API 先看 `node_modules/next/dist/docs/`。

- [ ] **Step 1: 接口加设计字段**

`wemedia-studio/lib/api/writing-plans.ts` 顶部 import 加 `CoverStyle`:
```ts
import { CoverStyle } from './publish-accounts'
```
`WritingPlan` 接口(`:21`)加:
```ts
  cover_style?: CoverStyle
  image_style?: string
```
`WritingPlanCreate`(`:36`)与 `WritingPlanUpdate`(`:43`)各加同样两行(可选)。

- [ ] **Step 2: dispatchPlan 签名扩展**

把 `dispatchPlan`(`:142`)改为接收 options 对象:

```ts
export async function dispatchPlan(
  planId: number,
  opts: { accountId?: string; angle?: string; draftType?: string; coverStyle?: CoverStyle; imageStyle?: string } = {},
): Promise<DispatchResult> {
  return apiFetch<DispatchResult>(`/writing-plans/${planId}/dispatch`, {
    method: 'POST',
    body: JSON.stringify({
      account_id: opts.accountId,
      angle: opts.angle,
      draft_type: opts.draftType ?? 'article',
      cover_style: opts.coverStyle,
      image_style: opts.imageStyle,
    }),
  })
}
```

- [ ] **Step 3: 类型检查**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 报错仅出现在 `WritingPlansClient.tsx`(旧 `dispatchPlan(id, accountId)` 调用方式),Task 7 修复;`writing-plans.ts` 本身无错。

- [ ] **Step 4: Commit**

```bash
git add wemedia-studio/lib/api/writing-plans.ts
git commit -m "feat(ui-api): plan design fields + dispatchPlan goal options"
```

---

## Task 7: 方案编辑 — cover_style / image_style

**Files:**
- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.tsx`

参照 `wemedia-studio/app/settings/sections/PublishAccountsSection.tsx:476` 的 `CoverStyleEditor` 用法(import、state、`buildCoverStyleFromEditor`)。

- [ ] **Step 1: import 编辑器**

`WritingPlansClient.tsx` 顶部 import 区加:
```ts
import { CoverStyleEditor, buildCoverStyleFromEditor } from '@/components/features/CoverStyleEditor'
import type { CoverStyle } from '@/lib/api/publish-accounts'
```

- [ ] **Step 2: 加编辑 state**

在 meta 编辑 state 附近(`:191-194`)加:
```ts
  const [editCoverStyle, setEditCoverStyle] = useState<CoverStyle>({})
  const [editCoverMotifs, setEditCoverMotifs] = useState('')
  const [editCoverNegative, setEditCoverNegative] = useState('')
  const [editImageStyle, setEditImageStyle] = useState('')
```
当 `selected` 变化时(已有的 selected→edit 同步 effect 内)回填:
```ts
    setEditCoverStyle(selected?.cover_style ?? {})
    setEditCoverMotifs((selected?.cover_style?.signature_motifs ?? []).join('\n'))
    setEditCoverNegative((selected?.cover_style?.negative ?? []).join('\n'))
    setEditImageStyle(selected?.image_style ?? '')
```

- [ ] **Step 3: 在方案元信息编辑区渲染编辑器 + 保存**

在方案 meta 编辑区(`editingTitle`/`editPriority` 保存逻辑附近)加一段「视觉设计(覆盖账号默认)」:
```tsx
  <div className="space-y-2">
    <div className="text-xs font-medium text-zinc-500">视觉设计（留空=继承账号默认）</div>
    <Input
      placeholder="插图风格 image_style（覆盖账号）"
      value={editImageStyle}
      onChange={e => setEditImageStyle(e.target.value)}
      className="h-8 text-xs"
    />
    <CoverStyleEditor
      coverStyle={editCoverStyle}
      onCoverStyleChange={setEditCoverStyle}
      motifsText={editCoverMotifs}
      onMotifsTextChange={setEditCoverMotifs}
      negativeText={editCoverNegative}
      onNegativeTextChange={setEditCoverNegative}
    />
    <Button size="sm" onClick={saveDesign}>保存视觉设计</Button>
  </div>
```
并加 `saveDesign`:
```ts
  async function saveDesign() {
    if (!selected) return
    const cover_style = buildCoverStyleFromEditor(editCoverStyle, editCoverMotifs, editCoverNegative)
    const updated = await updateWritingPlan(selected.id, { cover_style, image_style: editImageStyle })
    setPlans(ps => ps.map(p => p.id === updated.id ? updated : p))
    setSelected(updated)
    toast.success('视觉设计已保存')
  }
```

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`(本任务相关无错)
手动:打开 `/writing-plans`,选方案,改封面 type/palette + image_style,保存,刷新页面值仍在。

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/app/writing-plans/WritingPlansClient.tsx
git commit -m "feat(ui): edit plan-level cover_style/image_style"
```

---

## Task 8: 派发 — angle / draft_type / 本次设计覆盖

**Files:**
- Modify: `wemedia-studio/app/writing-plans/WritingPlansClient.tsx`(已有 `showDispatchConfirm` 派发确认流程,`:186-188`)

- [ ] **Step 1: 加派发目标 state**

派发相关 state 附近加:
```ts
  const [dispatchAngle, setDispatchAngle] = useState('')
  const [dispatchDraftType, setDispatchDraftType] = useState<'article' | 'script'>('article')
```

- [ ] **Step 2: 派发确认 UI 加输入项**

在 `showDispatchConfirm` 的确认弹窗里(已选账号那块附近)加:
```tsx
  <Input
    placeholder="本次切入角度（可选，覆盖『自己找角度』）"
    value={dispatchAngle}
    onChange={e => setDispatchAngle(e.target.value)}
    className="h-8 text-xs"
  />
  <div className="flex gap-2 text-xs">
    {(['article', 'script'] as const).map(t => (
      <button key={t} type="button"
        onClick={() => setDispatchDraftType(t)}
        className={cn('px-2 py-1 rounded border',
          dispatchDraftType === t ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 text-zinc-500')}>
        {t === 'article' ? '文章' : '脚本'}
      </button>
    ))}
  </div>
```
（封面/插图「本次临时覆盖」可复用 Task 7 的 `CoverStyleEditor`,放可折叠区;若想精简,本次覆盖可后续再加,先接 angle + draft_type。)

- [ ] **Step 3: 改派发调用**

把已有 `dispatchPlan(selected.id, accountId)` 调用改为:
```ts
      const res = await dispatchPlan(selected.id, {
        accountId: dispatchAccountId ?? undefined,
        angle: dispatchAngle || undefined,
        draftType: dispatchDraftType,
      })
```
（`dispatchAccountId` 用派发弹窗里已选的账号 state 名;若名字不同,按文件实际变量替换。)派发成功后重置:`setDispatchAngle(''); setDispatchDraftType('article')`。

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `cd wemedia-studio && pnpm exec tsc --noEmit`
Expected: 无错(Task 6 的旧调用报错此处消除)。
手动:在 `/writing-plans` 选方案 → 派发,填 angle、选脚本 → 确认。后端日志看到 editor body 含角度块,`pipeline_tasks.goal` 有值。

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/app/writing-plans/WritingPlansClient.tsx
git commit -m "feat(ui): dispatch with angle + draft_type goals"
```

---

## 收尾验证

- [ ] 后端全测:`cd backend && conda run -n wems pytest tests/test_design_merge.py tests/test_writing_plans.py tests/test_pipeline_template_topic.py -q` → 全绿
- [ ] 前端类型:`cd wemedia-studio && pnpm exec tsc --noEmit` → 无错
- [ ] 端到端手测:方案设封面/插图 → 派发(带 angle/draft_type)→ editor/illustrator body 体现 merged 设计 + 角度;产出 draft 的 `draft_type` 正确

## Self-Review 备注(已核对)

- **Spec 覆盖**:① 模型 = Task1;② merge 函数 = Task3;③ dispatch 扩展 = Task2/4;④ draft_type 透传 = Task5;⑤ 前端 = Task6-8。全覆盖。
- **类型一致**:`resolve_effective_design` 六参签名在 Task3 定义、Task4 调用一致;`dispatchPlan(planId, opts)` 在 Task6 定义、Task8 调用一致。
- **范围**:`script` 仅透传打标,不定制文风(spec 已声明)。

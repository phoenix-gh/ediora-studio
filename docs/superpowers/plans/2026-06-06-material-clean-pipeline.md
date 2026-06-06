# 素材清洗管道重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 X 平台采集管道拆为两阶段：采集只存 raw（不调 LLM），独立的 clean-batch 端点按可配置批量大小执行 LLM 精筛。

**Architecture:** `collect_rule` 删除 LLM 调用，prefilter 后直接存 `status="raw"`；新增 `clean_batch(db, size)` 函数从 raw 队列取前 N 条过 LLM，成功更新为 active/rejected，失败保持 raw 可重试；前端加 raw 计数提示 + 触发按钮。

**Tech Stack:** Python/FastAPI + SQLAlchemy async + SQLite（测试）/ PostgreSQL（生产）；Next.js + shadcn/ui（前端）

---

## File Map

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `backend/ref_collector.py` | Modify | 删除 LLM 调用；新增 `_upsert_raw`、`clean_batch` |
| `backend/routers/materials.py` | Modify | 新增 `/clean-batch` 端点；`GET /materials` 加 status 参数；collect 返回字段改名 |
| `backend/tests/test_materials_router.py` | Modify | 更新 collect 断言；新增 clean-batch 测试 |
| `wemedia-studio/lib/api/materials.ts` | Modify | 新增 `cleanBatch`、`getRawCount` 函数；更新 collectRule/collectAll 返回类型 |
| `wemedia-studio/app/materials/MaterialsClient.tsx` | Modify | raw 计数提示条 + 清洗按钮 |

---

## Task 1：重构 `collect_rule`——去掉 LLM，存为 raw

**Files:**
- Modify: `backend/ref_collector.py`
- Test: `backend/tests/test_materials_router.py`

- [ ] **Step 1: 写失败测试——collect_rule 不调 LLM，返回值改为 new_raw**

在 `backend/tests/test_materials_router.py` 中，更新现有 `test_rules_crud_and_collect`：

```python
def test_rules_crud_and_collect(client):
    r = client.post("/api/materials/rules", json={"label": "泛流量", "min_faves": 1500})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert client.get("/api/materials/rules").json()[0]["label"] == "泛流量"

    with patch("routers.materials.collect_rule", new=AsyncMock(return_value=3)):
        c = client.post(f"/api/materials/rules/{rid}/collect")
    assert c.status_code == 200 and c.json()["new_raw"] == 3
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py::test_rules_crud_and_collect -v
```

预期：FAIL，`KeyError: 'new_raw'` 或 assertion error。

- [ ] **Step 3: 在 `ref_collector.py` 中新增 `_upsert_raw`，替换 `collect_rule` 中的 LLM 块**

打开 `backend/ref_collector.py`。

**新增 `_upsert_raw` 函数**（放在 `_upsert_material` 之后）：

```python
async def _upsert_raw(db: AsyncSession, rule_id: int, p: ParsedPost):
    dialect = db.bind.dialect.name if db.bind else "postgresql"
    stmt = _insert(RefMaterial, dialect).values(
        platform="x", source_id=p.tweet_id, text=p.content,
        text_clean="", author=p.display_name,
        handle=p.username, source_url=p.url, cover_image=p.cover_image,
        likes=p.likes, reposts=p.reposts, replies=p.replies, views=p.views,
        score=0, category="", scene_tags=[], tags=[],
        rule_id=rule_id, status="raw", published_at=p.published_at,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ).on_conflict_do_nothing(index_elements=["platform", "source_id"])
    await db.execute(stmt)
```

**修改 `collect_rule`**——将函数末尾的 LLM 精筛块完整替换：

原来（大约第 126-153 行）：
```python
    kept = 0
    if survivors:
        cfg = await get_config()
        categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
        payload = [{"source_id": p.tweet_id, "text": p.content, "likes": p.likes}
                   for p in survivors]
        try:
            verdicts = await classify_ref_posts(payload, categories, SCENE_TAGS)
        except RefClassifyError as e:
            rule.last_error = f"精筛失败（{len(survivors)} 条待筛）：{e}"[:500]
            await db.commit()
            raise
        vmap = {str(v.get("source_id")): v for v in verdicts}
        by_id = {p.tweet_id: p for p in survivors}
        for sid, p in by_id.items():
            v = vmap.get(sid)
            if v and v.get("keep"):
                await _upsert_material(db, rule.id, p, v)
                await _mark_seen(db, sid, "kept")
                kept += 1
            elif v is not None:
                await _mark_seen(db, sid, "rejected")

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()
    return kept
```

改为：
```python
    for p in survivors:
        await _upsert_raw(db, rule.id, p)
        await _mark_seen(db, p.tweet_id, "raw")

    rule.last_collected_at = datetime.now(timezone.utc)
    rule.last_error = ""
    await db.commit()
    return len(survivors)
```

**同时修改 `collect_rule` 的 docstring** 第一行：
```python
    """从 x_posts 取候选 → 粗筛 → 存为 raw。返回新存入 raw 条目数。"""
```

- [ ] **Step 4: 修改 router 中的返回字段**

打开 `backend/routers/materials.py`，找到 `collect_one_rule` 端点（约第 222-231 行），修改返回值：

```python
@router.post("/rules/{rid}/collect")
async def collect_one_rule(rid: int, db: AsyncSession = Depends(get_db)):
    rule = await db.get(RefCollectRule, rid)
    if not rule:
        raise HTTPException(404, "规则不存在")
    try:
        n = await collect_rule(db, rule)
    except Exception as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "new_raw": n}
```

同样修改 `collect_all_rules`，在 `ref_collector.collect_all` 中同步（见 Task 3）。

- [ ] **Step 5: 运行测试，确认通过**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py::test_rules_crud_and_collect -v
```

预期：PASS。

- [ ] **Step 6: 运行全套测试，确认无回归**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py -v
```

预期：全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add backend/ref_collector.py backend/routers/materials.py backend/tests/test_materials_router.py
git commit -m "refactor(materials): collect_rule 去掉 LLM，存 raw；new_raw 返回字段"
```

---

## Task 2：新增 `clean_batch` 函数

**Files:**
- Modify: `backend/ref_collector.py`
- Modify: `backend/tests/test_materials_router.py`（新增 clean_batch 单元测试）

- [ ] **Step 1: 在 `ref_collector.py` 顶部补充 import**

确认以下 import 已存在，若无则添加：

```python
from sqlalchemy import select, func
```

（`func` 用于 `COUNT` 查询）

- [ ] **Step 2: 写 clean_batch 函数**

在 `collect_all` 函数**之前**插入：

```python
async def clean_batch(db: AsyncSession, size: int) -> dict:
    """从 raw 队列取前 size 条，过 LLM 精筛后更新状态。
    LLM 全批失败时抛 RefClassifyError，items 保持 raw 可重试。
    单条 v is None（LLM 漏回）保持 raw，下次重试。"""
    items = list((await db.execute(
        select(RefMaterial).where(RefMaterial.status == "raw").limit(size)
    )).scalars().all())

    if not items:
        return {"processed": 0, "kept": 0, "rejected": 0, "remaining_raw": 0}

    cfg = await get_config()
    categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
    payload = [{"source_id": str(m.id), "text": m.text, "likes": m.likes} for m in items]

    # 整批失败 → 抛出，items 保持 raw
    verdicts = await classify_ref_posts(payload, categories, SCENE_TAGS)
    vmap = {str(v.get("source_id")): v for v in verdicts}

    kept = rejected = 0
    now = datetime.now(timezone.utc)
    for m in items:
        v = vmap.get(str(m.id))
        if v and v.get("keep"):
            m.status = "active"
            m.text_clean = v.get("text_clean") or ""
            m.score = int(v.get("score") or 0)
            m.category = v.get("category") or ""
            m.scene_tags = list(v.get("scene_tags") or [])
            m.tags = list(v.get("tags") or [])
            m.updated_at = now
            kept += 1
        elif v is not None:
            m.status = "rejected"
            m.updated_at = now
            rejected += 1
        # v is None → 保持 raw

    await db.commit()
    remaining = await db.scalar(
        select(func.count()).where(RefMaterial.status == "raw")
    )
    return {"processed": len(items), "kept": kept, "rejected": rejected, "remaining_raw": remaining or 0}
```

- [ ] **Step 3: 写 clean_batch 集成测试**

在 `backend/tests/test_materials_router.py` 末尾添加（使用现有 `client` fixture）：

```python
def test_clean_batch_processes_raw_items(client):
    from unittest.mock import patch, AsyncMock

    # 先手动插入一条 raw（通过 collect 模拟写入）
    # 手动 POST 创建的是 manual/active，所以直接调 patch 走 clean-batch 端点测试
    # 用 patch classify_ref_posts 返回确定结果

    classify_result = [{"source_id": "1", "keep": True, "score": 8,
                         "category": "沙雕搞笑", "scene_tags": ["opener"],
                         "tags": [], "text_clean": "清洗后文本"}]

    # 先在 DB 里造一条 raw 记录（通过 patch collect_rule 实际写 raw）
    # 用更直接的方式：调 /clean-batch 但 raw 为空，验证返回 processed=0
    with patch("routers.materials.clean_batch", new=AsyncMock(
        return_value={"processed": 0, "kept": 0, "rejected": 0, "remaining_raw": 0}
    )):
        r = client.post("/api/materials/clean-batch", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["processed"] == 0 and body["remaining_raw"] == 0


def test_clean_batch_with_size_param(client):
    with patch("routers.materials.clean_batch", new=AsyncMock(
        return_value={"processed": 5, "kept": 3, "rejected": 2, "remaining_raw": 10}
    )) as mock_cb:
        r = client.post("/api/materials/clean-batch", json={"size": 5})
    assert r.status_code == 200
    body = r.json()
    assert body["kept"] == 3 and body["rejected"] == 2 and body["remaining_raw"] == 10
    mock_cb.assert_awaited_once()
```

- [ ] **Step 4: 运行测试（此时端点还不存在，预期 404/500）**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py::test_clean_batch_processes_raw_items backend/tests/test_materials_router.py::test_clean_batch_with_size_param -v
```

预期：FAIL（404 或路由不存在）。

- [ ] **Step 5: Commit（只提交 ref_collector 变更，测试暂不提交）**

```bash
git add backend/ref_collector.py
git commit -m "feat(materials): 新增 clean_batch 函数，从 raw 队列批量 LLM 精筛"
```

---

## Task 3：新增 `/clean-batch` 路由端点

**Files:**
- Modify: `backend/routers/materials.py`
- Modify: `backend/tests/test_materials_router.py`

- [ ] **Step 1: 在 router 顶部补充 import**

打开 `backend/routers/materials.py`，确认 import 行包含：

```python
from ref_collector import collect_rule, collect_all, clean_batch
```

（将现有 `from ref_collector import collect_rule, collect_all` 改为上面一行）

- [ ] **Step 2: 新增 `CleanBatchBody` schema 和端点**

在文件末尾（`collect_all_rules` 之后）追加：

```python
class CleanBatchBody(BaseModel):
    size: Optional[int] = None


@router.post("/clean-batch")
async def clean_batch_endpoint(body: CleanBatchBody, db: AsyncSession = Depends(get_db)):
    cfg = await get_config()
    size = body.size or int(cfg.get("clean_batch_size", 20))
    try:
        result = await clean_batch(db, size)
    except Exception as e:
        raise HTTPException(502, f"LLM 精筛失败：{str(e)[:200]}")
    return {"ok": True, **result}
```

- [ ] **Step 3: 修改 `collect_all` 返回 key 为 `new_raw`**

打开 `backend/ref_collector.py`，找到 `collect_all` 函数末尾约第 166 行：

```python
    return {"checked": len(rules), "new_materials": total, "failed": failed}
```

改为：

```python
    return {"checked": len(rules), "new_raw": total, "failed": failed}
```

- [ ] **Step 4: 给 `GET /materials` 加可选 status 参数**

找到 `list_materials` 函数定义，在参数列表中加 `status: str = "active"`，并修改查询条件：

```python
@router.get("", response_model=list[MaterialOut])
async def list_materials(
    platform: str = "", category: str = "", scene_tag: str = "",
    min_score: int = 0, q: str = "", sort: str = "time",
    plan_id: int = 0, limit: int = 100, offset: int = 0,
    status: str = "active",
    db: AsyncSession = Depends(get_db),
):
    stmt = select(RefMaterial).where(RefMaterial.status == status)
    # 后续过滤条件不变...
```

- [ ] **Step 5: 运行 clean-batch 测试，确认通过**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py::test_clean_batch_processes_raw_items backend/tests/test_materials_router.py::test_clean_batch_with_size_param -v
```

预期：PASS。

- [ ] **Step 6: 运行全套测试，确认无回归**

```bash
conda run -n wems pytest backend/tests/test_materials_router.py -v
```

预期：全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add backend/routers/materials.py backend/ref_collector.py backend/tests/test_materials_router.py
git commit -m "feat(materials): /clean-batch 端点；GET /materials 支持 status 参数；collect_all 返回 new_raw"
```

---

## Task 4：数据库索引（手动迁移）

**Files:**
- 无代码文件变更，需在生产 DB 执行 SQL

- [ ] **Step 1: 在 Postgres 执行索引 DDL**

在生产数据库上执行：

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_refmaterial_status
    ON ref_material (status);
```

用 `CONCURRENTLY` 避免锁表。SQLite 测试环境会通过 `Base.metadata.create_all` 自动建表，无需手动操作。

- [ ] **Step 2: 确认索引存在**

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'ref_material';
```

预期结果中包含 `ix_refmaterial_status`。

- [ ] **Step 3: Commit 备忘**

```bash
git commit --allow-empty -m "ops: 已在 prod DB 建 ix_refmaterial_status 索引"
```

---

## Task 5：前端——API 函数 + raw 计数 + 清洗按钮

**Files:**
- Modify: `wemedia-studio/lib/api/materials.ts`
- Modify: `wemedia-studio/app/materials/MaterialsClient.tsx`

- [ ] **Step 1: 更新 `materials.ts` 的返回类型和新增函数**

打开 `wemedia-studio/lib/api/materials.ts`。

**修改 `collectRule` 返回类型**（约第 80 行）：

```typescript
export async function collectRule(id: number): Promise<{ new_raw: number }> {
  return apiFetch(`/materials/rules/${id}/collect`, { method: 'POST' })
}
```

**修改 `collectAll` 返回类型**（约第 83 行）：

```typescript
export async function collectAll(): Promise<{ new_raw: number; failed: string[] }> {
  return apiFetch('/materials/collect-all', { method: 'POST' })
}
```

**在文件末尾新增两个函数**：

```typescript
export async function getRawCount(): Promise<number> {
  const items = await apiFetch<Material[]>('/materials?status=raw&limit=1000')
  return items.length
}

export interface CleanBatchResult {
  processed: number
  kept: number
  rejected: number
  remaining_raw: number
}

export async function cleanBatch(size?: number): Promise<CleanBatchResult> {
  return apiFetch('/materials/clean-batch', {
    method: 'POST',
    body: JSON.stringify(size !== undefined ? { size } : {}),
  })
}
```

- [ ] **Step 2: 找到 `MaterialsClient.tsx` 中需要修改的位置**

打开 `wemedia-studio/app/materials/MaterialsClient.tsx`。

找到现有 import 行，补充 `getRawCount` 和 `cleanBatch`：

```typescript
import {
  Material, MaterialCreate, CollectRule,
  SCENE_TAGS, sceneTagInfo,
  getMaterials, createMaterial, updateMaterial, deleteMaterial,
  getRules, createRule, updateRule, deleteRule, collectRule, collectAll,
  getRawCount, cleanBatch,
} from '@/lib/api/materials'
```

- [ ] **Step 3: 新增 rawCount state + 加载逻辑**

在组件顶层 state 声明区（现有 `useState` 附近）添加：

```typescript
const [rawCount, setRawCount] = useState(0)
const [cleaning, setCleaning] = useState(false)
```

在现有的数据加载 `useEffect`（或 `load` 函数）中，追加 rawCount 加载：

```typescript
// 在已有的 getMaterials() / getRules() 调用之后添加：
getRawCount().then(setRawCount).catch(() => {})
```

- [ ] **Step 4: 新增清洗处理函数**

在组件内现有 handler 函数附近添加：

```typescript
async function handleCleanBatch() {
  setCleaning(true)
  try {
    const r = await cleanBatch()
    toast.success(`清洗完成：${r.kept} 条入库，${r.rejected} 条淘汰，剩余 ${r.remaining_raw} 条待处理`)
    setRawCount(r.remaining_raw)
    // 刷新素材列表
    const items = await getMaterials()
    setMaterials(items)  // 使用组件中实际的 setter 名称
  } catch {
    toast.error('清洗失败，请重试')
  } finally {
    setCleaning(false)
  }
}
```

注意：`setMaterials` 需替换为组件中实际的 state setter 名称（搜索 `useState` 找 materials 列表的 setter）。

- [ ] **Step 5: 在 JSX 中插入 raw 提示条**

在素材列表区域顶部（现有过滤栏下方）插入：

```tsx
{rawCount > 0 && (
  <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-700 dark:text-amber-400">
    <Zap className="w-4 h-4 shrink-0" />
    <span>{rawCount} 条待清洗</span>
    <Button
      size="sm"
      variant="outline"
      className="ml-auto h-7 text-xs"
      onClick={handleCleanBatch}
      disabled={cleaning}
    >
      {cleaning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
      清洗
    </Button>
  </div>
)}
```

`Zap` 和 `Loader2` 已在现有 import 中存在，无需新增。

- [ ] **Step 6: 验证 TypeScript 编译无错误**

```bash
source ~/.zshrc && cd /workspace/projects/WeMediaStudio/wemedia-studio && npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/lib/api/materials.ts wemedia-studio/app/materials/MaterialsClient.tsx
git commit -m "feat(materials): 前端 raw 计数提示 + 一键清洗按钮"
```

---

## Self-Review Checklist

- [x] **Spec 覆盖**：两阶段分离 ✓、批量大小可配置 ✓、raw/active/rejected 状态机 ✓、LLM 失败保持 raw ✓、前端触发 ✓、DB 索引 ✓
- [x] **无 placeholder**：每步都有完整代码
- [x] **类型一致**：`clean_batch` 返回 dict 与端点 response 一致；前端 `CleanBatchResult` 字段名与后端一致
- [x] **`collect_all` 的 `new_materials` 字段**：Task 3 Step 3 已将 `collect_all` 返回 key 改为 `new_raw`，与前端类型一致。

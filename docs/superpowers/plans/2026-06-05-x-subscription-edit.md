# X 订阅可编辑搜索规则 + 新建可命名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 X 搜索订阅建好后能改 `raw_query` / `max_results`，并在新建订阅时可填可选「名称」。

**Architecture:** 后端 `PATCH /x/subscriptions/{id}` 放开 `raw_query`/`max_results`（搜索订阅专用，时间线传 raw_query 报 400）；前端新建表单加可选名称框（后端 label 早已支持），搜索行 ✏️ 接管顶部表单进入编辑模式复用查询 textarea + chips。不自动重采集。

**Tech Stack:** FastAPI + SQLAlchemy async (Postgres/SQLite)、pytest TestClient、Next.js + React + shadcn/ui (TypeScript)。

**环境提示:** 所有 python/pytest 命令须加 `conda run -n wems` 前缀；前端命令前先 `source ~/.zshrc`。

---

## File Structure

- `backend/routers/x.py` — `SubscriptionPatch` schema 加 2 字段；`patch_subscription` handler 应用并校验。
- `backend/tests/test_x_router.py` — 新增 4 条 PATCH/create 测试。
- `web/lib/api/x.ts` — `patchXSubscription` body 类型扩字段。
- `web/app/x/XClient.tsx` — 新建表单名称框；搜索行 ✏️ 编辑模式；提交分发到 patch。

---

## Task 1: 后端 PATCH 放开 raw_query / max_results

**Files:**
- Modify: `backend/routers/x.py:52-55` (`SubscriptionPatch`)
- Modify: `backend/routers/x.py:143-157` (`patch_subscription`)
- Test: `backend/tests/test_x_router.py`

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_x_router.py` 末尾追加：

```python
def test_patch_search_raw_query_and_max_results(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI lang:zh", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={
        "raw_query": "  (AI OR 大模型) lang:zh  ", "max_results": 80,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["raw_query"] == "(AI OR 大模型) lang:zh"  # trimmed
    assert body["max_results"] == 80


def test_patch_max_results_clamped(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"max_results": 9999})
    assert r.status_code == 200, r.text
    assert r.json()["max_results"] == 500  # clamped to upper bound


def test_patch_raw_query_on_timeline_rejected(client):
    sub = client.post(BASE, json={"url": "https://x.com/a"}).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"raw_query": "AI"})
    assert r.status_code == 400


def test_patch_search_raw_query_empty_rejected(client):
    sub = client.post(BASE, json={
        "kind": "search", "raw_query": "AI", "max_results": 50,
    }).json()
    r = client.patch(f"{BASE}/{sub['id']}", json={"raw_query": "   "})
    assert r.status_code == 400
```

- [ ] **Step 2: 跑测试确认失败**

Run: `conda run -n wems python -m pytest backend/tests/test_x_router.py::test_patch_search_raw_query_and_max_results backend/tests/test_x_router.py::test_patch_max_results_clamped backend/tests/test_x_router.py::test_patch_raw_query_on_timeline_rejected backend/tests/test_x_router.py::test_patch_search_raw_query_empty_rejected -v`
Expected: FAIL（PATCH 忽略 raw_query/max_results，断言不满足；时间线/空查询不报 400）

- [ ] **Step 3: 扩 `SubscriptionPatch`**

`backend/routers/x.py` 把：

```python
class SubscriptionPatch(BaseModel):
    enabled: Optional[bool] = None
    label: Optional[str] = None
```

改为：

```python
class SubscriptionPatch(BaseModel):
    enabled: Optional[bool] = None
    label: Optional[str] = None
    raw_query: Optional[str] = None
    max_results: Optional[int] = None
```

- [ ] **Step 4: 在 handler 应用并校验**

`backend/routers/x.py` 的 `patch_subscription`，在 `if body.label is not None:` 块之后、`await db.commit()` 之前插入：

```python
    if body.raw_query is not None:
        if sub.kind != "search":
            raise HTTPException(400, "时间线订阅没有搜索规则可改")
        rq = body.raw_query.strip()
        if not rq:
            raise HTTPException(400, "搜索订阅需要 raw_query")
        sub.raw_query = rq
    if body.max_results is not None:
        sub.max_results = max(1, min(500, body.max_results))
```

- [ ] **Step 5: 跑测试确认通过**

Run: `conda run -n wems python -m pytest backend/tests/test_x_router.py -v`
Expected: 全部 PASS（含原有用例）

- [ ] **Step 6: 提交**

```bash
git add backend/routers/x.py backend/tests/test_x_router.py
git commit -m "feat(x): PATCH subscription can edit raw_query/max_results (search only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 后端新建带 label 测试（防回归，无实现改动）

**Files:**
- Test: `backend/tests/test_x_router.py`

后端 `create_subscription` 已支持 `body.label`；本任务只加防回归测试，确认显式 label 被采用而非自动命名。

- [ ] **Step 1: 写测试**

在 `backend/tests/test_x_router.py` 末尾追加：

```python
def test_create_timeline_with_explicit_label(client):
    r = client.post(BASE, json={
        "url": "https://x.com/elonmusk", "label": "马斯克",
    })
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "马斯克"  # not auto "@elonmusk"
```

- [ ] **Step 2: 跑测试确认通过**

Run: `conda run -n wems python -m pytest backend/tests/test_x_router.py::test_create_timeline_with_explicit_label -v`
Expected: PASS（后端已支持，应直接绿）

- [ ] **Step 3: 提交**

```bash
git add backend/tests/test_x_router.py
git commit -m "test(x): explicit label on create is honored over auto-naming

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 前端 API 类型扩字段

**Files:**
- Modify: `web/lib/api/x.ts:106-114` (`patchXSubscription`)

- [ ] **Step 1: 扩 body 类型**

`web/lib/api/x.ts` 把：

```ts
export async function patchXSubscription(
  id: number,
  body: Partial<Pick<XSubscription, 'enabled' | 'label'>>,
): Promise<XSubscription> {
```

改为：

```ts
export async function patchXSubscription(
  id: number,
  body: Partial<Pick<XSubscription, 'enabled' | 'label' | 'raw_query' | 'max_results'>>,
): Promise<XSubscription> {
```

- [ ] **Step 2: 类型检查**

Run: `source ~/.zshrc && cd web && npx tsc --noEmit`
Expected: 无新增报错（此改动只放宽类型）

- [ ] **Step 3: 提交**

```bash
git add web/lib/api/x.ts
git commit -m "feat(x): patchXSubscription accepts raw_query/max_results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 新建表单加可选「名称」输入

**Files:**
- Modify: `web/app/x/XClient.tsx`（`SubscribeDialog`，state 区 ~480、`submit` ~504、表单 JSX ~548-584）

- [ ] **Step 1: 加 label state**

在 `SubscribeDialog` 内 `const [rawQuery, setRawQuery] = useState('')` 下方加：

```tsx
  const [name, setName] = useState('')
```

- [ ] **Step 2: submit 携带 name，并清空**

把 `submit` 内两处 `onAdd(...)` 调用改为带 `label`，并在成功分支清空 `name`：

```tsx
      if (kind === 'search') {
        const q = rawQuery.trim()
        if (!q) return
        await onAdd({ kind: 'search', raw_query: q, max_results: maxResults, label: name.trim() || undefined })
        setRawQuery('')
        setName('')
      } else {
        const trimmed = url.trim()
        if (!trimmed) return
        await onAdd({ kind: 'timeline', url: trimmed, label: name.trim() || undefined })
        setUrl('')
        setName('')
      }
```

- [ ] **Step 3: 加名称输入框（时间线 + 搜索都显示）**

在 `<div className="flex items-center gap-1.5">` 那组 时间线/搜索 切换按钮的 JSX 之后、`{kind === 'timeline' ? (` 之前插入：

```tsx
        <Input value={name} onChange={e => setName(e.target.value)}
          placeholder="名称（可选，留空自动命名）"
          className="h-8 text-xs" />
```

- [ ] **Step 4: 类型检查**

Run: `source ~/.zshrc && cd web && npx tsc --noEmit`
Expected: 无新增报错（`CreateXSubscriptionInput.label` 已存在）

- [ ] **Step 5: 提交**

```bash
git add web/app/x/XClient.tsx
git commit -m "feat(x): optional name field when creating a subscription

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 搜索行 ✏️ 接管顶部表单进入编辑模式

**Files:**
- Modify: `web/app/x/XClient.tsx`（`SubscribeDialog`：state、submit、表单标题/按钮、搜索行 ✏️ onClick）

设计：新增 `editingSearchId` 表示「顶部表单处于搜索编辑模式」。点搜索行 ✏️ → 预填 `rawQuery`/`maxResults`/`name`、强制 `kind='search'`、记录 id。提交时若 `editingSearchId != null` 走 `patchXSubscription` 而非 `onAdd`。提供「取消」退出。时间线行 ✏️ 维持现有行内改名不变。

- [ ] **Step 1: 加编辑态 state 与进入/退出函数**

在 `const [name, setName] = useState('')` 下方加：

```tsx
  const [editingSearchId, setEditingSearchId] = useState<number | null>(null)

  const startEditSearch = (s: XSubscription) => {
    setKind('search')
    setRawQuery(s.raw_query)
    setMaxResults(s.max_results)
    setName(s.label)
    setEditingSearchId(s.id)
  }
  const cancelEditSearch = () => {
    setEditingSearchId(null)
    setRawQuery('')
    setMaxResults(50)
    setName('')
  }
```

- [ ] **Step 2: submit 分发到 patch**

把 `submit` 的搜索分支改为按 `editingSearchId` 分流：

```tsx
      if (kind === 'search') {
        const q = rawQuery.trim()
        if (!q) return
        if (editingSearchId != null) {
          await patchXSubscription(editingSearchId, {
            raw_query: q, max_results: maxResults, label: name.trim() || undefined,
          })
          toast.success('已保存修改')
          onSaved()
          cancelEditSearch()
        } else {
          await onAdd({ kind: 'search', raw_query: q, max_results: maxResults, label: name.trim() || undefined })
          setRawQuery('')
          setName('')
        }
      } else {
```

说明：`patchXSubscription` 需在文件顶部 import 中已存在（`createXSubscription, patchXSubscription, deleteXSubscription` 已 import，见 XClient.tsx:22）。`onSaved` 为新增 prop（下一步）。

- [ ] **Step 3: 新增 `onSaved` prop 让父组件刷新列表**

`SubscribeDialog` 的 props 类型（`onRename` 同级）加：

```tsx
  onSaved: () => Promise<void>
```

并在解构参数里加 `onSaved`。父组件 `<SubscribeDialog ... onRename={handleRename} />` 处补 `onSaved={reloadSubs}`（`reloadSubs` 是顶层组件已有的列表刷新函数，见 XClient.tsx:52）。

- [ ] **Step 4: 编辑模式下锁 kind 切换 + 改按钮/标题**

把 时间线/搜索 切换按钮组包一层条件：编辑中隐藏（避免切走）。即把：

```tsx
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant={kind === 'timeline' ? 'default' : 'outline'}
            className="h-7 text-xs" onClick={() => setKind('timeline')}>时间线</Button>
          <Button type="button" size="sm" variant={kind === 'search' ? 'default' : 'outline'}
            className="h-7 text-xs" onClick={() => setKind('search')}>搜索</Button>
        </div>
```

改为：

```tsx
        {editingSearchId == null ? (
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant={kind === 'timeline' ? 'default' : 'outline'}
              className="h-7 text-xs" onClick={() => setKind('timeline')}>时间线</Button>
            <Button type="button" size="sm" variant={kind === 'search' ? 'default' : 'outline'}
              className="h-7 text-xs" onClick={() => setKind('search')}>搜索</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-amber-600">
            <Pencil className="w-3 h-3" /> 正在编辑搜索订阅
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs ml-auto"
              onClick={cancelEditSearch}>取消</Button>
          </div>
        )}
```

把搜索表单提交按钮文案按编辑态切换。即把：

```tsx
              <Button type="submit" size="sm" className="h-8 text-xs ml-auto"
                disabled={adding || !rawQuery.trim()}>
                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '添加搜索订阅'}
              </Button>
```

改为：

```tsx
              <Button type="submit" size="sm" className="h-8 text-xs ml-auto"
                disabled={adding || !rawQuery.trim()}>
                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : (editingSearchId != null ? '保存修改' : '添加搜索订阅')}
              </Button>
```

- [ ] **Step 5: 搜索行 ✏️ 改为进入编辑模式**

订阅列表行里那颗重命名 ✏️ 按钮（XClient.tsx ~667-672）的 onClick 当前是 `() => { setEditValue(s.label); setEditingId(s.id) }`。改为按 kind 分流：

```tsx
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                          disabled={busyId === s.id}
                          onClick={() => {
                            if (s.kind === 'search') {
                              startEditSearch(s)
                            } else {
                              setEditValue(s.label); setEditingId(s.id)
                            }
                          }}
                          title={s.kind === 'search' ? '编辑' : '重命名'}>
                          <Pencil className="w-3 h-3" />
                        </Button>
```

- [ ] **Step 6: 类型检查**

Run: `source ~/.zshrc && cd web && npx tsc --noEmit`
Expected: 无报错

- [ ] **Step 7: 手动验证（启动应用）**

启动前后端，打开 X 页面 → 「订阅管理」：
1. 新建一条搜索订阅（填名称）→ 列表显示该名称。
2. 点该行 ✏️ → 顶部表单预填查询/条数/名称，标题「正在编辑搜索订阅」。
3. 改查询 + 用 chips 插 token → 「保存修改」→ toast「已保存修改」，列表行查询语句更新。
4. 「取消」→ 表单回到新建态。
5. 时间线订阅点 ✏️ → 仍是行内改名，不进顶部表单。

- [ ] **Step 8: 提交**

```bash
git add web/app/x/XClient.tsx
git commit -m "feat(x): edit a search subscription's query/max_results via the top form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** 后端 PATCH 放开字段 (Task 1) ✓；新建命名 (Task 2 测试 + Task 4 UI) ✓；搜索行完整编辑复用表单 (Task 5) ✓；API 类型 (Task 3) ✓；测试四条 (Task 1) + 命名防回归 (Task 2) ✓。
- **不自动重采集:** PATCH 仅保存，符合非目标；用户用行内「采集」按钮重采。
- **类型一致:** `patchXSubscription(id, { raw_query, max_results, label })` 字段与 Task 3 扩展的 `Pick<…,'raw_query'|'max_results'>` + 既有 `'label'` 对齐；`startEditSearch`/`cancelEditSearch`/`editingSearchId`/`onSaved` 在 Task 5 内自洽；父组件刷新函数 `reloadSubs` 已确认 (XClient.tsx:52)。

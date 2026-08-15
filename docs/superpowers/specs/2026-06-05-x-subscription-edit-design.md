# X 订阅：可编辑搜索规则 + 新建时可命名

## 背景与问题

X 订阅当前有两个缺口：

1. **搜索订阅的搜索规则建好后无法修改。** 后端 `PATCH /x/subscriptions/{id}` 只接受 `enabled` 和 `label`，没有 `raw_query` / `max_results`，前端也没有编辑入口。想改查询语句只能删了重建。
2. **新建时无法自定义名称。** 后端 `SubscriptionCreate.label` 其实早就支持，但新建表单没有「名称」输入框，名称只能靠自动生成（时间线抓真实昵称，搜索用 `搜索:{query前24字}`）。建好后虽有 ✏️ 行内改名，但无法在创建当下命名。

## 目标

- 搜索订阅建好后能改 `raw_query` 和 `max_results`。
- 新建时（时间线 / 搜索都可）能填可选的「名称」。

## 非目标

- 不自动重采集：PATCH 仅保存；列表每行已有「采集」按钮，用户改完查询自行点击。
- 不扩展可编辑的搜索高级参数（min_faves / lang / days / sort 等当前连新建表单都未暴露），保持与新建表单一致，只动 `raw_query` + `max_results`。
- 时间线订阅的 URL 不可编辑（URL 是唯一键，改 URL 等于新建）。

## 设计

### 1. 后端：`PATCH /x/subscriptions/{id}` 放开搜索字段

文件：`backend/routers/x.py`

- `SubscriptionPatch` 增加：
  - `raw_query: Optional[str] = None`
  - `max_results: Optional[int] = None`
- `patch_subscription` handler：
  - `enabled` / `label`：维持现状。
  - `raw_query` 提供时：要求 `sub.kind == "search"` 且 `strip()` 后非空，否则 `HTTPException(400, ...)`（时间线订阅没有查询语句可改）。存 `sub.raw_query = raw_query.strip()`。
  - `max_results` 提供时：约束到 1–500（越界则 clamp 或 400 —— 实现取 clamp，与新建表单宽松取值一致）。存 `sub.max_results`。
- 返回 `await _to_out(db, sub)`，与现有一致。

### 2. 新建表单加可选「名称」输入

文件：`web/app/x/XClient.tsx`（`SubscribeDialog`），类型在 `web/lib/api/x.ts`

- 后端 `SubscriptionCreate.label` 与前端 `CreateXSubscriptionInput.label` 已支持，无需改类型。
- `SubscribeDialog` 新增 `const [label, setLabel] = useState('')`。
- 时间线、搜索两种 kind 的表单都加一个可选「名称」`Input`（placeholder 提示留空则自动命名）。
- `submit` 时 `onAdd` 传入 `label: label.trim() || undefined`；提交成功后清空 `label`。

### 3. 搜索订阅的 ✏️ 改为「完整编辑」（复用顶部表单）

文件：`web/app/x/XClient.tsx`，类型在 `web/lib/api/x.ts`

- **时间线行**：✏️ 保持现有的行内改名（label-only）。
- **搜索行**：点 ✏️ → 顶部表单进入「编辑模式」：
  - 预填该订阅的 `raw_query` / `max_results` / `名称`，kind 锁定为 `search`（编辑期间隐藏/禁用时间线·搜索切换）。
  - 复用现成的查询 textarea + 快捷 chips。
  - 主按钮变「保存修改」，并提供「取消」退出编辑模式（清空预填、恢复新建态）。
  - 提交走 `patchXSubscription(id, { raw_query, max_results, label })`，成功后退出编辑模式并刷新列表。
- 编辑模式用一个 state 表示，如 `const [editingSearchId, setEditingSearchId] = useState<number | null>(null)`；与时间线行内改名的 `editingId` 互不干扰。

### 4. API 层类型

文件：`web/lib/api/x.ts`

- `patchXSubscription` 的 body 类型从 `Partial<Pick<XSubscription, 'enabled' | 'label'>>` 扩成 `Partial<Pick<XSubscription, 'enabled' | 'label' | 'raw_query' | 'max_results'>>`。

## 测试

文件：`backend/tests/test_x_router.py`

- PATCH 改搜索订阅的 `raw_query` → 生效（返回体 + 落库）。
- PATCH 改搜索订阅的 `max_results` → 生效。
- PATCH 对时间线订阅传 `raw_query` → 返回 400。
- 新建带 `label` → 落库使用该 label（而非自动生成）。

## 数据流

```
[新建] 表单(可选名称) → POST /x/subscriptions {kind,url|raw_query,label?,max_results?}
                       → XSubscription 落库（label 留空走自动命名）

[编辑搜索] 搜索行 ✏️ → 顶部表单编辑模式(预填) → PATCH /x/subscriptions/{id}
                       {raw_query?, max_results?, label?} → 保存；用户自行点「采集」重采
```

## 错误处理

- PATCH 对时间线订阅改 `raw_query`：400「时间线订阅没有搜索规则可改」。
- PATCH 搜索订阅 `raw_query` 为空：400「搜索订阅需要 raw_query」（复用新建的措辞）。
- 前端编辑模式提交失败：toast 报错，保持编辑模式不退出。

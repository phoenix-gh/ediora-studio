# 素材清洗管道重构设计

**日期：** 2026-06-06  
**范围：** X 平台采集管道，将一步式"采集+LLM"拆为两阶段，支持可配置批量清洗

---

## 背景与目标

当前 `collect_rule()` 在采集时同步调用 LLM 精筛，单次最多处理 40 条，无法精确控制 token 消耗。重构目标：

1. 采集阶段不调 LLM，只做规则粗筛后存入 `status="raw"`
2. 清洗阶段独立触发，批量大小由参数控制，LLM 失败可重试
3. 不改变现有 LLM prompt / `classify_ref_posts` 逻辑

---

## 状态机

```
[采集] XPost → _prefilter → raw
[清洗] raw → classify_ref_posts → active（通过）| rejected（淘汰）
                                → raw（LLM 失败，保留重试）
```

| status | 含义 |
|--------|------|
| `raw` | 已采集、待 LLM 清洗 |
| `active` | 清洗通过，展示在素材库 |
| `rejected` | LLM 淘汰，不展示但保留记录 |

---

## 数据层

### RefMaterial

无新列。`status` 字段沿用 String，新增 `"raw"` / `"rejected"` 取值。

需手动执行：
```sql
CREATE INDEX IF NOT EXISTS ix_refmaterial_status ON ref_material (status);
```

### RefSeen

`verdict` 新增 `"raw"` 值，表示该推文已存为 raw，防止 collect 重复拉取。

现有 verdict 值 `"kept"` / `"rejected"` 保持不变（历史数据）。

---

## 后端变更

### `backend/ref_collector.py`

**删除：** `collect_rule` 中 LLM 调用块（`classify_ref_posts` 及后续 upsert 逻辑）

**新增：** `_upsert_raw(db, rule_id, post)` —— 只写采集字段，LLM 字段留空，`status="raw"`

**修改：** `collect_rule` 改为：
```python
for p in survivors:
    await _upsert_raw(db, rule.id, p)
    await _mark_seen(db, p.tweet_id, "raw")
rule.last_collected_at = now()
rule.last_error = ""
await db.commit()
return len(survivors)  # 返回 new_raw 数量
```

**新增：** `clean_batch(db, size) -> dict`

```python
async def clean_batch(db: AsyncSession, size: int) -> dict:
    # 1. 取前 size 条 raw
    items = (await db.execute(
        select(RefMaterial).where(RefMaterial.status == "raw").limit(size)
    )).scalars().all()
    if not items:
        return {"processed": 0, "kept": 0, "rejected": 0, "remaining_raw": 0}

    # 2. LLM 精筛（整批失败时抛 RefClassifyError，items 保持 raw）
    cfg = await get_config()
    categories = [c for c in cfg.get("ref_categories", "").split(",") if c]
    payload = [{"source_id": str(m.id), "text": m.text, "likes": m.likes} for m in items]
    verdicts = await classify_ref_posts(payload, categories, SCENE_TAGS)
    vmap = {str(v["source_id"]): v for v in verdicts}

    # 3. 更新状态
    kept = rejected = 0
    for m in items:
        v = vmap.get(str(m.id))
        if v and v.get("keep"):
            m.status = "active"
            m.text_clean = v.get("text_clean") or ""
            m.score = int(v.get("score") or 0)
            m.category = v.get("category") or ""
            m.scene_tags = list(v.get("scene_tags") or [])
            m.tags = list(v.get("tags") or [])
            m.updated_at = now()
            kept += 1
        elif v is not None:
            m.status = "rejected"
            rejected += 1
        # v is None → 保持 raw，下次重试

    await db.commit()
    remaining = await db.scalar(
        select(func.count()).where(RefMaterial.status == "raw")
    )
    return {"processed": len(items), "kept": kept, "rejected": rejected, "remaining_raw": remaining}
```

### `backend/routers/materials.py`

**新增端点：**

```python
class CleanBatchBody(BaseModel):
    size: Optional[int] = None  # None → 读 config clean_batch_size，默认 20

@router.post("/clean-batch")
async def clean_batch_endpoint(body: CleanBatchBody, db: AsyncSession = Depends(get_db)):
    cfg = await get_config()
    size = body.size or int(cfg.get("clean_batch_size", 20))
    try:
        result = await clean_batch(db, size)
    except RefClassifyError as e:
        raise HTTPException(502, f"LLM 精筛失败：{e}")
    return {"ok": True, **result}
```

**修改：** `GET /materials` 新增可选 `status: str = "active"` 查询参数，默认行为不变。

**修改：** `POST /rules/{rid}/collect` 返回字段 `new_materials` 改为 `new_raw`。

### Config

全局 config 新增 key `clean_batch_size`，默认值 `20`，用户可在设置页修改。

---

## 前端变更（`MaterialsClient.tsx`）

1. 新增 `getRawCount()` API 调用（`GET /materials?status=raw&limit=1` 取 count，或专用 count 端点）
2. 当 raw 数量 > 0 时，在素材页顶部展示提示条：「N 条待清洗」+ 「清洗」按钮
3. 点击「清洗」：调 `POST /materials/clean-batch`（使用 config 默认 size），完成后 toast 显示结果并刷新列表

---

## 错误处理

| 场景 | 行为 |
|------|------|
| LLM 整批失败 | items 保持 `raw`，端点返回 502 + 错误信息 |
| LLM 部分条目缺失（v is None）| 该条保持 `raw`，下次 clean-batch 重试 |
| 采集阶段失败 | 同现在，写 `rule.last_error`，seen 不记录 |
| clean-batch 时 raw 为空 | 正常返回 `processed=0` |

---

## 不在范围内

- 其他平台（Reddit、YouTube 等）接入素材库
- 自动定时触发清洗（手动触发为主）
- 清洗进度实时推送（WebSocket/SSE）

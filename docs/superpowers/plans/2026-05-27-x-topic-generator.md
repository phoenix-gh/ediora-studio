# X 热点选题生成器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/trend-topics` 页面，用户选择账号后点「生成选题」，后端查过去 24h X 帖子、调 LLM 生成 10 条长/短文选题卡片，用户勾选后一键入队到 `wms_editor`。

**Architecture:** 新增 `backend/routers/topic_generator.py` 处理 `POST /api/topic-generator/generate`，直查 `x_posts` 表、调 `llm._call()`、返回 JSON；前端 `app/trend-topics/` 页面 + Client 组件负责渲染卡片和入队逻辑（调 `/api/topic-generator/enqueue`）。

**Tech Stack:** FastAPI + SQLAlchemy async（后端）、Next.js App Router + shadcn/ui + Tailwind（前端）、pytest + FastAPI TestClient + SQLite（测试）

---

## 文件地图

| 操作 | 路径 |
|------|------|
| 新增 | `backend/routers/topic_generator.py` |
| 修改 | `backend/main.py` |
| 新增 | `backend/tests/test_topic_generator.py` |
| 新增 | `web/lib/api/topic-generator.ts` |
| 新增 | `web/app/trend-topics/page.tsx` |
| 新增 | `web/app/trend-topics/TopicGeneratorClient.tsx` |
| 修改 | `web/components/features/Sidebar.tsx` |
| 修改 | `~/.hermes/profiles/wms_editor/SOUL.md` |

---

## Task 1: 后端 router — generate 接口

**Files:**
- Create: `backend/routers/topic_generator.py`
- Test: `backend/tests/test_topic_generator.py`

- [ ] **Step 1: 写失败测试（generate 返回 10 条选题）**

```python
# backend/tests/test_topic_generator.py
import sys
import asyncio
import json
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient

FAKE_TOPICS = [
    {
        "title": f"选题{i}",
        "angle": f"角度{i}",
        "type": "long" if i % 2 == 0 else "short",
        "source_posts": [{"username": "@ai_user", "content": "内容片段", "url": "https://x.com/1"}],
    }
    for i in range(10)
]

LLM_JSON_RESPONSE = json.dumps(FAKE_TOPICS, ensure_ascii=False)


@pytest.fixture
def client(monkeypatch, tmp_path):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    # Seed XPost rows in the past 24h
    from database import SessionLocal
    from models import XPost

    async def _seed():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            for i in range(10):
                db.add(XPost(
                    tweet_id=f"tweet_{i}",
                    subscription_id=1,
                    username=f"user{i}",
                    display_name=f"User {i}",
                    content=f"AI 帖子内容 {i}，关于大模型的讨论",
                    url=f"https://x.com/user{i}/status/{i}",
                    published_at=now - timedelta(hours=i),
                    collected_at=now,
                    likes=100 - i * 5,
                    reposts=50 - i * 2,
                    replies=20,
                ))
            await db.commit()
    asyncio.new_event_loop().run_until_complete(_seed())

    # Mock llm._call
    import llm as llm_mod

    async def _fake_call(prompt, max_tokens=2048):
        return LLM_JSON_RESPONSE

    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    return TestClient(app)


def test_generate_returns_ten_topics(client):
    r = client.post("/api/topic-generator/generate", json={"account_id": None, "sources": ["x"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "topics" in body
    assert len(body["topics"]) == 10
    t = body["topics"][0]
    assert "title" in t
    assert "angle" in t
    assert t["type"] in ("long", "short")
    assert isinstance(t["source_posts"], list)


def test_generate_warning_when_no_posts(monkeypatch, tmp_path):
    # Fresh empty DB — not using the `client` fixture (that one seeds 10 posts)
    db_file = tmp_path / "empty.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_file}")
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")

    for mod in list(sys.modules):
        if mod.startswith(("database", "models", "main", "routers", "config",
                            "llm", "topic_generator")):
            sys.modules.pop(mod, None)

    from database import engine, Base
    import models  # noqa: F401

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    asyncio.new_event_loop().run_until_complete(_create())

    import llm as llm_mod

    async def _fake_call(prompt, max_tokens=2048):
        return "[]"

    monkeypatch.setattr(llm_mod, "_call", _fake_call)

    from main import app
    from fastapi.testclient import TestClient as TC
    c = TC(app)
    r = c.post("/api/topic-generator/generate", json={"account_id": None, "sources": ["x"]})
    assert r.status_code == 200
    body = r.json()
    assert body["warning"] is not None
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems pytest tests/test_topic_generator.py -v 2>&1 | tail -20
```
预期：`ImportError` 或 `404`（router 还不存在）

- [ ] **Step 3: 实现 `backend/routers/topic_generator.py`**

```python
# backend/routers/topic_generator.py
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import XPost, PublishAccount

router = APIRouter(prefix="/topic-generator", tags=["topic-generator"])


class SourcePost(BaseModel):
    username: str
    content: str
    url: str


class TopicSuggestion(BaseModel):
    title: str
    angle: str
    type: str  # "long" | "short"
    source_posts: list[SourcePost]


class GenerateRequest(BaseModel):
    account_id: Optional[str] = None
    sources: list[str] = ["x"]


class GenerateResponse(BaseModel):
    warning: Optional[str] = None
    topics: list[TopicSuggestion]


@router.post("/generate", response_model=GenerateResponse)
async def generate_topics(body: GenerateRequest, db: AsyncSession = Depends(get_db)):
    from llm import _call

    since = datetime.now(timezone.utc) - timedelta(hours=24)

    posts = (await db.execute(
        select(XPost)
        .where(XPost.published_at >= since)
        .order_by(desc(XPost.likes + XPost.reposts))
        .limit(50)
    )).scalars().all()

    warning = None
    if len(posts) < 5:
        warning = "过去 24 小时内 X 数据不足（< 5 条），建议在「设置 → X」补充订阅源。已尽力生成。"

    account_profile = ""
    if body.account_id:
        acc = await db.get(PublishAccount, body.account_id)
        if acc:
            account_profile = (
                f"\n\n【目标账号画像】\n"
                f"名称：{acc.name}\n"
                f"定位：{acc.positioning}\n"
                f"受众：{acc.audience}\n"
                f"调性：{acc.tone}\n"
                f"选题重点：{', '.join(acc.topic_focus) if acc.topic_focus else '不限'}\n"
                f"禁区：{', '.join(acc.taboo) if acc.taboo else '无'}"
            )

    posts_text = "\n".join(
        f"{idx+1}. @{p.username}（赞{p.likes} 转{p.reposts}）: {p.content[:200]}"
        for idx, p in enumerate(posts)
    ) or "（暂无数据）"

    prompt = (
        "你是资深自媒体策划，擅长从社交媒体热点中提炼有价值的创作选题。\n\n"
        f"【过去 24 小时 X 热门帖子】\n{posts_text}"
        f"{account_profile}\n\n"
        "请根据以上内容，生成 10 条候选选题。\n"
        "要求：\n"
        "- type 只能是 \"long\"（1500-3000 字深度文章）或 \"short\"（200-500 字 X 风格短帖）\n"
        "- 长短文各约 5 条，根据话题深度判断\n"
        "- source_posts 列出该选题参考的 1-3 条原帖摘要\n"
        "- 仅输出 JSON 数组，不要任何解释文字，格式：\n"
        '[{"title":"...","angle":"...","type":"long|short",'
        '"source_posts":[{"username":"@xxx","content":"...","url":"..."}]}]'
    )

    try:
        raw = await _call(prompt, max_tokens=3000)
    except Exception as e:
        raise HTTPException(500, f"LLM 调用失败: {e}")

    # Strip markdown code fences if present
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            raise ValueError("not a list")
        topics = [TopicSuggestion(**item) for item in data[:10]]
    except Exception as e:
        raise HTTPException(500, f"LLM 输出解析失败: {e}\n原始输出: {raw[:500]}")

    return GenerateResponse(warning=warning, topics=topics)
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems pytest tests/test_topic_generator.py -v 2>&1 | tail -20
```
预期：2 tests PASSED

- [ ] **Step 5: Commit**

```bash
git add backend/routers/topic_generator.py backend/tests/test_topic_generator.py
git commit -m "feat(topic-generator): add POST /api/topic-generator/generate"
```

---

## Task 2: 注册 router + enqueue 接口

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/routers/topic_generator.py`（追加 enqueue endpoint）

- [ ] **Step 1: 写 enqueue 失败测试**

在 `backend/tests/test_topic_generator.py` 末尾追加：

```python
def test_enqueue_topic(client, monkeypatch):
    import hermes_kanban_client as hkc

    created_ids = []

    async def _fake_create(self, *, title, body, assignee, parents=None):
        created_ids.append({"title": title, "assignee": assignee, "body": body})
        return "task_001"

    monkeypatch.setattr(hkc.HermesKanbanClient, "create_task", _fake_create)

    payload = {
        "account_id": None,
        "topics": [
            {
                "title": "AI 大模型趋势深度报告",
                "angle": "从 GPT-4o 说起",
                "type": "long",
                "source_posts": [{"username": "@openai", "content": "...", "url": "https://x.com/1"}],
            }
        ],
    }
    r = client.post("/api/topic-generator/enqueue", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enqueued"] == 1
    assert len(created_ids) == 1
    assert created_ids[0]["assignee"] == "wms_editor"
    assert "long" in created_ids[0]["body"]
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems pytest tests/test_topic_generator.py::test_enqueue_topic -v 2>&1 | tail -10
```
预期：`404`（enqueue endpoint 不存在）

- [ ] **Step 3: 在 topic_generator.py 追加 enqueue endpoint**

在文件顶部 import 区块追加：
```python
from hermes_kanban_client import HermesKanbanClient
```

然后在文件末尾追加 endpoint：

```python
# 追加到 backend/routers/topic_generator.py 末尾（import 已在顶部）


class EnqueueRequest(BaseModel):
    account_id: Optional[str] = None
    topics: list[TopicSuggestion]


class EnqueueResponse(BaseModel):
    enqueued: int
    task_ids: list[str]


@router.post("/enqueue", response_model=EnqueueResponse)
async def enqueue_topics(body: EnqueueRequest):
    kanban = HermesKanbanClient()
    task_ids: list[str] = []

    for topic in body.topics:
        word_range = "1500-3000 字" if topic.type == "long" else "200-500 字"
        content_type_label = "长文" if topic.type == "long" else "短文"

        sources_md = "\n".join(
            f"- {p.username}: {p.content[:120]} [{p.url}]"
            for p in topic.source_posts
        )

        task_body = (
            f"**体裁**: {content_type_label}（{word_range}）\n"
            f"**content_type**: {topic.type}\n"
            f"**word_range**: {word_range}\n"
            + (f"**account_id**: {body.account_id}\n" if body.account_id else "")
            + f"\n**切入角度**: {topic.angle}\n"
            f"\n**参考帖子**:\n{sources_md or '（无）'}\n"
            f"\n**generated_by**: topic_generator"
        )

        try:
            tid = await kanban.create_task(
                title=topic.title,
                body=task_body,
                assignee="wms_editor",
            )
            task_ids.append(tid)
        except Exception as e:
            raise HTTPException(500, f"入队失败: {e}")

    return EnqueueResponse(enqueued=len(task_ids), task_ids=task_ids)
```

- [ ] **Step 4: 在 `backend/main.py` 注册 router**

在 `main.py` 的 import 行找到：
```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, content_topics, quotes, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit
```
替换为（末尾加 `, topic_generator`）：
```python
from routers import accounts, collect, settings, github, x, papers, personas, upload, drafts, content_topics, quotes, synthesize, youtube, producthunt, wechat, v2ex, kr, juejin, studio, publish_accounts, profiles, reddit, topic_generator
```

然后在 `main.py:79`（`app.include_router(reddit.router, prefix="/api")`）下一行加：
```python
app.include_router(topic_generator.router, prefix="/api")
```

- [ ] **Step 5: 运行所有 topic_generator 测试**

```bash
cd /workspace/projects/WeMediaStudio/backend
conda run -n wems pytest tests/test_topic_generator.py -v 2>&1 | tail -20
```
预期：3 tests PASSED

- [ ] **Step 6: 冒烟测试 live 后端**

```bash
curl -s -X POST http://localhost:8000/api/topic-generator/generate \
  -H "Content-Type: application/json" \
  -d '{"account_id": null, "sources": ["x"]}' | python3 -m json.tool | head -30
```
预期：返回含 `topics` 数组的 JSON（或 warning + topics）

- [ ] **Step 7: Commit**

```bash
git add backend/routers/topic_generator.py backend/main.py backend/tests/test_topic_generator.py
git commit -m "feat(topic-generator): add enqueue endpoint + register router"
```

---

## Task 3: 前端 API 客户端

**Files:**
- Create: `web/lib/api/topic-generator.ts`

- [ ] **Step 1: 创建 API 客户端**

```typescript
// web/lib/api/topic-generator.ts
import { apiFetch } from './client'

export interface SourcePost {
  username: string
  content: string
  url: string
}

export interface TopicSuggestion {
  title: string
  angle: string
  type: 'long' | 'short'
  source_posts: SourcePost[]
}

export interface GenerateResponse {
  warning: string | null
  topics: TopicSuggestion[]
}

export interface EnqueueResponse {
  enqueued: number
  task_ids: string[]
}

export async function generateTopics(opts: {
  account_id: string | null
  sources?: string[]
}): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/topic-generator/generate', {
    method: 'POST',
    body: JSON.stringify({ account_id: opts.account_id, sources: opts.sources ?? ['x'] }),
  })
}

export async function enqueueTopics(opts: {
  account_id: string | null
  topics: TopicSuggestion[]
}): Promise<EnqueueResponse> {
  return apiFetch<EnqueueResponse>('/topic-generator/enqueue', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add web/lib/api/topic-generator.ts
git commit -m "feat(topic-generator): add frontend API client"
```

---

## Task 4: 前端页面

**Files:**
- Create: `web/app/trend-topics/page.tsx`
- Create: `web/app/trend-topics/TopicGeneratorClient.tsx`

需要用到的 shadcn 组件（项目已有）：`Button`、`Badge`、`Checkbox`、`Select`、`Card`、`Collapsible`、`Sonner toast`。

- [ ] **Step 1: 创建 Server Component 壳**

```typescript
// web/app/trend-topics/page.tsx
export const dynamic = 'force-dynamic'

import { TopicGeneratorClient } from './TopicGeneratorClient'
import { apiFetch } from '@/lib/api/client'

interface PublishAccount {
  id: string
  name: string
  platform: string
  is_active: boolean
}

export default async function TrendTopicsPage() {
  const accounts = await apiFetch<PublishAccount[]>('/publish-accounts').catch(() => [])
  return <TopicGeneratorClient accounts={accounts} />
}
```

- [ ] **Step 2: 创建 Client Component**

```typescript
// web/app/trend-topics/TopicGeneratorClient.tsx
'use client'

import { useState } from 'react'
import { Lightbulb, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { generateTopics, enqueueTopics, TopicSuggestion } from '@/lib/api/topic-generator'

interface PublishAccount {
  id: string
  name: string
  platform: string
  is_active: boolean
}

interface TopicCard extends TopicSuggestion {
  checked: boolean
  enqueued: boolean
  expanded: boolean
}

export function TopicGeneratorClient({ accounts }: { accounts: PublishAccount[] }) {
  const [accountId, setAccountId] = useState<string>('__none__')
  const [cards, setCards] = useState<TopicCard[]>([])
  const [generating, setGenerating] = useState(false)
  const [enqueueing, setEnqueueing] = useState(false)

  const selectedCount = cards.filter(c => c.checked && !c.enqueued).length

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await generateTopics({
        account_id: accountId === '__none__' ? null : accountId,
      })
      if (res.warning) toast.warning(res.warning)
      setCards(
        res.topics.map(t => ({ ...t, checked: false, enqueued: false, expanded: false }))
      )
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  function toggleCheck(idx: number) {
    setCards(prev =>
      prev.map((c, i) => (i === idx && !c.enqueued ? { ...c, checked: !c.checked } : c))
    )
  }

  function toggleExpand(idx: number) {
    setCards(prev => prev.map((c, i) => (i === idx ? { ...c, expanded: !c.expanded } : c)))
  }

  async function handleEnqueue() {
    const toEnqueue = cards.filter(c => c.checked && !c.enqueued)
    if (!toEnqueue.length) return
    setEnqueueing(true)
    try {
      const res = await enqueueTopics({
        account_id: accountId === '__none__' ? null : accountId,
        topics: toEnqueue,
      })
      toast.success(`已入队 ${res.enqueued} 条选题`)
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h1 className="text-lg font-semibold">热点选题生成</h1>
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-6 py-4 flex items-center gap-3 border-b border-zinc-100 dark:border-zinc-800">
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="不绑定账号" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">不绑定账号</SelectItem>
            {accounts.filter(a => a.is_active).map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />生成中…</>
            : <><Lightbulb className="w-4 h-4 mr-2" />生成选题</>
          }
        </Button>
      </div>

      {/* Cards */}
      {cards.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          {generating ? '正在分析过去 24 小时的 X 热帖…' : '点击「生成选题」开始'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cards.map((card, idx) => (
              <div
                key={idx}
                className={`rounded-lg border p-4 transition-opacity ${
                  card.enqueued ? 'opacity-50' : ''
                } ${card.checked ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/20' : 'border-zinc-200 dark:border-zinc-800'}`}
              >
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={card.checked}
                    onCheckedChange={() => toggleCheck(idx)}
                    disabled={card.enqueued}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant={card.type === 'long' ? 'default' : 'secondary'}
                        className={card.type === 'long' ? 'bg-blue-600' : 'bg-green-600 text-white'}>
                        {card.type === 'long' ? '长文' : '短文'}
                      </Badge>
                      {card.enqueued && (
                        <Badge variant="outline" className="text-zinc-400">已入队</Badge>
                      )}
                    </div>
                    <p className="font-medium text-sm leading-snug mb-1">{card.title}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{card.angle}</p>

                    {/* Collapsible source posts */}
                    {card.source_posts.length > 0 && (
                      <button
                        onClick={() => toggleExpand(idx)}
                        className="mt-2 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600"
                      >
                        {card.expanded
                          ? <><ChevronUp className="w-3 h-3" />收起参考帖子</>
                          : <><ChevronDown className="w-3 h-3" />展开参考帖子（{card.source_posts.length}）</>
                        }
                      </button>
                    )}
                    {card.expanded && (
                      <ul className="mt-2 space-y-1">
                        {card.source_posts.map((p, pi) => (
                          <li key={pi} className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
                            <span className="font-mono text-zinc-400">{p.username}</span>{' '}
                            {p.content.slice(0, 100)}{p.content.length > 100 ? '…' : ''}{' '}
                            <a href={p.url} target="_blank" rel="noreferrer"
                              className="text-indigo-500 hover:underline">[链接]</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer action bar */}
      {cards.length > 0 && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-6 py-3 flex items-center justify-between">
          <span className="text-sm text-zinc-500">已选 {selectedCount} 条</span>
          <Button
            onClick={handleEnqueue}
            disabled={selectedCount === 0 || enqueueing}
          >
            {enqueueing
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />入队中…</>
              : `入队选中项（${selectedCount}）`
            }
          </Button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/trend-topics/
git commit -m "feat(topic-generator): add /trend-topics page with card selection UI"
```

---

## Task 5: 侧边栏入口

**Files:**
- Modify: `web/components/features/Sidebar.tsx`

- [ ] **Step 1: 在 Sidebar 添加 Lightbulb import 和导航项**

在 `Sidebar.tsx` 第 5 行找到 lucide 导入行：
```typescript
import {
  LayoutDashboard, TrendingUp, Settings, GitFork, AtSign, FileText, BookMarked, Tag, Quote,
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, Bot, UserCog, Hash,
} from 'lucide-react'
```
替换为（加入 `Lightbulb`）：
```typescript
import {
  LayoutDashboard, TrendingUp, Settings, GitFork, AtSign, FileText, BookMarked, Tag, Quote,
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, Bot, UserCog, Hash, Lightbulb,
} from 'lucide-react'
```

在 `sections` 的 `创作` 分组找到：
```typescript
    items: [
      { href: '/drafts',    label: '草稿箱',     icon: BookMarked },
      { href: '/topics',    label: '选题库',     icon: Tag },
      { href: '/quotes',    label: '金句库',     icon: Quote },
    ],
```
替换为（在最后加一行）：
```typescript
    items: [
      { href: '/drafts',         label: '草稿箱',     icon: BookMarked },
      { href: '/topics',         label: '选题库',     icon: Tag },
      { href: '/quotes',         label: '金句库',     icon: Quote },
      { href: '/trend-topics',   label: '热点选题',   icon: Lightbulb },
    ],
```

- [ ] **Step 2: 验证前端编译无报错**

```bash
cd /workspace/projects/WeMediaStudio/web
pnpm build 2>&1 | tail -20
```
预期：`✓ Compiled successfully` 或 `Route (app)` 表格里有 `/trend-topics`

- [ ] **Step 3: 浏览器验证**

打开 `http://localhost:3000/trend-topics`，确认：
- 侧边栏出现「热点选题」入口（Lightbulb 图标）
- 页面有账号下拉 + 「生成选题」按钮
- 点击「生成选题」后 loading 状态正常，返回 10 张卡片
- 卡片有长文/短文 badge，勾选后底部显示「入队选中项」按钮

- [ ] **Step 4: Commit**

```bash
git add web/components/features/Sidebar.tsx
git commit -m "feat(topic-generator): add trend-topics sidebar entry"
```

---

## Task 6: wms_editor SOUL.md 更新

**Files:**
- Modify: `~/.hermes/profiles/wms_editor/SOUL.md`

- [ ] **Step 1: 在 SOUL.md 末尾追加 content_type 处理说明**

在 `/home/violet/.hermes/profiles/wms_editor/SOUL.md` 末尾追加：

```markdown

## 接收「热点选题」任务时

如果任务 body 包含 `**content_type**` 字段：
- `content_type: long` → brief 的字数规格按 `word_range` 给出的范围（通常 1500-3000 字），角度要有深度、有数据、有观点
- `content_type: short` → brief 的字数规格按 `word_range`（通常 200-500 字），风格简洁、适合 X 发帖，一个核心观点
- 任务 body 中的 `**切入角度**` 作为 brief 的起点，可微调但不得偏离主题
- 任务 body 中的 `**参考帖子**` 是原始素材依据，brief 里需引用至少 1 条
```

- [ ] **Step 2: 验证 SOUL.md 内容**

```bash
cat /home/violet/.hermes/profiles/wms_editor/SOUL.md
```
预期：末尾有新增的「接收「热点选题」任务时」章节

- [ ] **Step 3: Commit**

```bash
git add /home/violet/.hermes/profiles/wms_editor/SOUL.md 2>/dev/null || true
# SOUL.md 不在 git 里，记录变更即可
git -C /workspace/projects/WeMediaStudio commit --allow-empty -m "docs(editor): note wms_editor SOUL.md updated for content_type routing"
```

---

## 验收标准

1. `POST /api/topic-generator/generate` 返回 10 条含 `long`/`short` 分类的选题
2. `POST /api/topic-generator/enqueue` 成功创建 Hermes 任务，assignee 为 `wms_editor`，body 含 `content_type`
3. `/trend-topics` 页面完整渲染：账号选择、生成按钮、卡片网格、入队操作
4. 入队后卡片变灰、显示「已入队」badge，不可重复入队
5. `conda run -n wems pytest backend/tests/test_topic_generator.py -v` 全部通过

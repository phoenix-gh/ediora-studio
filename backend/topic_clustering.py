import hashlib
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from embeddings import cosine_similarity, embed_text, embedding_threshold
from models import TopicCluster


NOISE_WORDS = [
    "刚刚", "突发", "重磅", "震惊", "全网", "热议", "最新", "独家", "深度", "详解",
    "一文", "看懂", "来了", "官宣", "发布", "曝光", "揭秘", "为什么", "如何",
]


def make_id(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:16]


def normalize_text(text: str) -> str:
    text = text.lower()
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[@#][\w\u4e00-\u9fff_-]+", "", text)
    for word in NOISE_WORDS:
        text = text.replace(word, "")
    text = re.sub(r"[^\w\u4e00-\u9fff]+", "", text)
    return text[:120]


def event_key(text: str) -> str:
    normalized = normalize_text(text)
    keys = []
    entity_groups = [
        ("musk", ["马斯克", "elon", "musk", "xai", "grok"]),
        ("openai", ["openai", "chatgpt", "gpt"]),
        ("distill", ["蒸馏", "distill"]),
        ("apple", ["苹果", "apple"]),
        ("claude", ["claude"]),
        ("image", ["image", "图像", "生图", "中文渲染", "修字"]),
        ("deepseek", ["deepseek"]),
    ]
    raw = text.lower()
    for key, words in entity_groups:
        if any(word.lower() in raw or word.lower() in normalized for word in words):
            keys.append(key)
    if len(keys) >= 2:
        return ":".join(keys)
    return ""


def similarity(a: str, b: str) -> float:
    left_key = event_key(a)
    right_key = event_key(b)
    if left_key and left_key == right_key:
        return 1.0
    left = normalize_text(a)
    right = normalize_text(b)
    if not left or not right:
        return 0
    ratio = SequenceMatcher(None, left, right).ratio()
    left_chars = set(left)
    right_chars = set(right)
    overlap = len(left_chars & right_chars) / max(1, len(left_chars | right_chars))
    return ratio * 0.65 + overlap * 0.35


def cluster_items(items: list[dict], threshold: float = 0.46) -> list[dict]:
    clusters: list[dict] = []
    for item in items:
        text = f"{item.get('title', '')}\n{item.get('content', '')[:180]}".strip()
        best_cluster = None
        best_score = 0.0
        for cluster in clusters:
            score = similarity(text, cluster["fingerprint"])
            if score > best_score:
                best_cluster = cluster
                best_score = score
        if best_cluster and best_score >= threshold:
            best_cluster["items"].append(item)
            if item.get("likes", 0) + item.get("reposts", 0) * 2 + item.get("comments", 0) > best_cluster["heat_score"]:
                best_cluster["fingerprint"] = text
                best_cluster["canonical_title"] = item.get("title") or item.get("content", "")[:40]
        else:
            clusters.append({
                "canonical_title": item.get("title") or item.get("content", "")[:40],
                "fingerprint": text,
                "items": [item],
                "heat_score": item.get("likes", 0) + item.get("reposts", 0) * 2 + item.get("comments", 0),
            })

    for cluster in clusters:
        sources = []
        heat_score = 0
        for item in cluster["items"]:
            heat_score += int(item.get("likes", 0)) + int(item.get("reposts", 0)) * 2 + int(item.get("comments", 0))
            if item.get("url"):
                sources.append({
                    "id": make_id(item["url"]),
                    "platform": item.get("platform", "来源"),
                    "title": item.get("title") or item.get("content", "")[:60],
                    "url": item["url"],
                    "publishedAt": item.get("published_at", datetime.now(timezone.utc).isoformat()),
                    "type": "primary",
                })
        cluster["sources"] = sources
        cluster["source_count"] = len({s["url"] for s in sources})
        cluster["heat_score"] = heat_score

    clusters.sort(key=lambda c: (c["source_count"], c["heat_score"]), reverse=True)
    return clusters


def cluster_embedding_text(cluster: dict) -> str:
    source_titles = "\n".join(
        f"- {source.get('title', '')}"
        for source in cluster.get("sources", [])[:12]
    )
    sample_items = "\n".join(
        f"- {item.get('title', '') or item.get('content', '')[:80]}"
        for item in cluster.get("items", [])[:8]
    )
    return "\n".join([
        f"主题: {cluster.get('canonical_title', '')}",
        f"摘要: {cluster.get('summary', '')}",
        "信源标题:",
        source_titles,
        "样本内容:",
        sample_items,
    ]).strip()


async def find_embedding_match(
    db: AsyncSession,
    embedding: list[float],
    threshold: float,
) -> TopicCluster | None:
    if not embedding:
        return None
    rows = (await db.execute(select(TopicCluster))).scalars().all()
    best: TopicCluster | None = None
    best_score = 0.0
    for row in rows:
        if not row.embedding:
            continue
        score = cosine_similarity(embedding, row.embedding or [])
        if score > best_score:
            best = row
            best_score = score
    if best and best_score >= threshold:
        return best
    return None


async def upsert_topic_cluster(db: AsyncSession, cluster: dict) -> TopicCluster:
    embedding: list[float] = []
    embedding_model = ""
    try:
        embedding, embedding_model = await embed_text(cluster_embedding_text(cluster))
    except Exception as e:
        print(f"[embedding] topic cluster embedding failed: {e}")

    threshold = await embedding_threshold()
    embedding_match = await find_embedding_match(db, embedding, threshold)
    if embedding_match:
        return merge_cluster(embedding_match, cluster, embedding, embedding_model)

    seed = event_key(cluster.get("fingerprint", "") or cluster.get("canonical_title", ""))
    if not seed:
        seed = normalize_text(cluster.get("canonical_title", "") or cluster.get("fingerprint", ""))
    cluster_id = make_id(seed)
    now = datetime.now(timezone.utc)
    existing = await db.get(TopicCluster, cluster_id)
    if existing:
        return merge_cluster(existing, cluster, embedding, embedding_model)

    obj = TopicCluster(
        id=cluster_id,
        canonical_title=cluster.get("canonical_title", "未命名主题"),
        summary=cluster.get("summary", ""),
        sources=cluster.get("sources", []),
        embedding=embedding,
        embedding_model=embedding_model,
        source_count=int(cluster.get("source_count", 0)),
        heat_score=int(cluster.get("heat_score", 0)),
        first_seen_at=now,
        last_seen_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(obj)
    return obj


def merge_cluster(
    existing: TopicCluster,
    cluster: dict,
    embedding: list[float] | None = None,
    embedding_model: str = "",
) -> TopicCluster:
    now = datetime.now(timezone.utc)
    urls = {s.get("url") for s in existing.sources or []}
    merged_sources = list(existing.sources or [])
    for source in cluster.get("sources", []):
        if source.get("url") and source["url"] not in urls:
            merged_sources.append(source)
            urls.add(source["url"])
    existing.sources = merged_sources
    existing.source_count = max(len(urls), existing.source_count, int(cluster.get("source_count", 0)))
    existing.heat_score = max(existing.heat_score, int(cluster.get("heat_score", 0)))
    existing.last_seen_at = now
    existing.updated_at = now
    if cluster.get("canonical_title") and len(cluster["canonical_title"]) < len(existing.canonical_title):
        existing.canonical_title = cluster["canonical_title"]
    if embedding and not existing.embedding:
        existing.embedding = embedding
        existing.embedding_model = embedding_model
    return existing

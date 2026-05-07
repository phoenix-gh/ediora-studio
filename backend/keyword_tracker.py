"""
Unified keyword system: extract terms from posts → compute heat → power both
the keyword heat ranking and the word cloud.

Flow each run:
  1. jieba posseg all posts from last 24h
  2. Keep only noun-class POS + english words
  3. Count per-document frequency (how many distinct posts contain the term)
  4. Upsert terms with doc_count >= MIN_DOC_FREQ into keywords table (skip blocked)
  5. Compute heat for ALL active keywords using engagement + velocity
  6. Save KeywordSnapshot for history
"""
import math
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import jieba
import jieba.posseg as pseg
jieba.setLogLevel(60)  # suppress INFO spam

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.dialects.sqlite import insert as _si

from models import Keyword, KeywordSnapshot, XPost, XPostMetrics, Post


# POS tags considered "meaningful nouns" by jieba
_KEEP_POS = {"n", "nr", "nt", "nz", "ns", "eng", "nrfg"}

# Minimum number of distinct posts a term must appear in
MIN_DOC_FREQ = 3
# Maximum ratio of posts a term can appear in (too ubiquitous = meaningless)
MAX_DOC_RATIO = 0.15

# Hard stopwords applied after POS filtering
_STOPWORDS = {
    # ── 泛化名词（无搜索价值）────────────────────────────────────────────────
    "时候", "方式", "问题", "情况", "内容", "方面", "东西", "事情", "地方",
    "原因", "结果", "过程", "系统", "功能", "平台", "产品", "服务", "用户",
    "团队", "公司", "项目", "版本", "数据", "信息", "资源", "需求", "目标",
    "效果", "质量", "标准", "方案", "工作", "时间", "方法", "手段", "工具",
    "使用", "发展", "建设", "管理", "研究", "分析", "设计", "测试", "部署",
    "核心", "行业", "市场", "成本", "规模", "优势", "流量", "媒体", "品牌",
    "竞争", "时代", "能力", "速度", "效率", "未来", "趋势", "领域", "层面",
    "环境", "背景", "影响", "关系", "机制", "体系", "模式", "逻辑", "思路",
    "阶段", "方向", "价值", "意义", "作用", "基础", "条件", "前提", "格局",
    "生态", "场景", "赛道", "机会", "挑战", "瓶颈", "壁垒", "红利",
    # ── 泛化人称 ──────────────────────────────────────────────────────────────
    "大家", "我们", "他们", "作者", "粉丝", "用户", "网友", "朋友", "读者",
    "观众", "玩家", "消费者", "从业者", "开发者", "创作者",
    # ── 泛化动作名词 ──────────────────────────────────────────────────────────
    "功能", "服务", "产品", "方案", "应用", "工具", "平台", "系统",
    # ── 英文噪声 ──────────────────────────────────────────────────────────────
    "the", "and", "for", "that", "this", "with", "from", "not", "but",
    "are", "was", "has", "have", "will", "can", "via", "its", "they",
    "http", "https", "com", "www", "org", "net", "app", "api", "url",
    "amp", "nbsp", "gt", "lt", "re", "rt", "yes", "no", "all", "new",
    "one", "two", "get", "use", "just", "like", "also", "more", "our",
    "of", "to", "in", "on", "at", "is", "it", "be", "do", "go", "an",
    "as", "by", "if", "or", "up", "so", "we", "he", "she", "me", "us",
    "my", "his", "her", "out", "off", "too", "how", "who", "what",
    # ── 量词/时间词 ───────────────────────────────────────────────────────────
    "一个", "一些", "一样", "很多", "没有", "可以", "因为", "所以",
    "今天", "昨天", "明天", "今年", "去年", "最近", "现在", "当前",
    # ── 地域/组织泛化词 ───────────────────────────────────────────────────────
    "全球", "国际", "官方", "政府", "机构", "组织", "协会", "委员会",
    # ── 描述性泛化词 ──────────────────────────────────────────────────────────
    "关键", "重要", "核心", "基本", "主要", "相关", "综合", "整体",
    "部分", "专业", "高度", "本质", "替代", "消耗", "基础",
    "传统", "普通", "一般", "常见", "简单", "复杂", "特殊", "正常",
    "想象", "理想", "真正", "所有", "任何", "各种", "其他",
    "门槛", "旗下", "背后", "以上", "以下", "左右", "以内",
    # ── 其他常见但无搜索价值的词 ──────────────────────────────────────────────
    "新人", "科技", "实际", "结构", "记录", "整理", "状态", "小时", "分钟",
    "机器", "工程", "情绪", "视频", "图片", "文章", "内容", "语言", "文字",
    "声音", "效果", "过程", "思考", "感觉", "体验", "经验", "知识", "学习",
    "理解", "认知", "思维", "逻辑", "策略", "计划", "目标", "成果",
    "网络", "设备", "界面", "页面", "节点", "模块", "框架", "库", "接口",
    "智能", "人类", "世界", "国家", "社会", "文化", "经济", "政治",
    "交易", "资产", "收入", "利润", "投资", "融资", "估值",  # 太泛的财经词
}


def _now():
    return datetime.now(timezone.utc)


_EN_STOPWORDS = _STOPWORDS | {
    # Common English adjectives / generic nouns that slip through as 'eng'
    "important", "traditional", "simple", "complex", "general", "specific",
    "different", "similar", "possible", "available", "current", "recent",
    "large", "small", "high", "low", "good", "bad", "free", "open",
    "based", "used", "made", "help", "need", "way", "time", "day",
    "people", "users", "team", "work", "data", "model", "system",
    "feature", "issue", "change", "version", "update", "release", "build",
    "support", "allow", "enable", "require", "include", "provide", "create",
    "stars", "forks", "watch", "clone", "fork", "pull", "push", "merge",
    "repo", "commit", "branch", "tag", "code", "file", "docs", "doc",
    "part", "list", "type", "note", "page", "site", "link", "post",
}


def _extract_terms(text: str) -> set[str]:
    """Return set of meaningful terms from a single post."""
    terms = set()
    for word, flag in pseg.cut(text):
        word = word.strip()
        pos = flag.split(".")[0]

        if pos not in _KEEP_POS:
            continue

        w_lower = word.lower()

        # English words: stricter check
        if pos == "eng":
            if len(word) < 3:
                continue
            if w_lower in _EN_STOPWORDS:
                continue
        else:
            if len(word) < 2:
                continue
            if w_lower in _STOPWORDS:
                continue

        # Skip pure numbers / URLs
        if all(c.isdigit() or c in ".,%-/" for c in word):
            continue
        if "http" in word or word.startswith("www"):
            continue

        terms.add(word)
    return terms


async def compute_keyword_heat(db: AsyncSession) -> dict:
    """
    Full pipeline: extract → upsert → compute heat → snapshot.
    Returns {extracted, updated}.
    """
    now = _now()
    cutoff_24h = now - timedelta(hours=24)
    cutoff_4h  = now - timedelta(hours=4)

    # ── 1. Load posts from last 24h ──────────────────────────────────────────
    x_posts = (await db.execute(
        select(XPost.tweet_id, XPost.content, XPost.published_at)
        .where(XPost.published_at >= cutoff_24h)
    )).all()

    gen_posts = (await db.execute(
        select(Post.id, Post.content, Post.published_at)
        .where(Post.published_at >= cutoff_24h)
    )).all()

    all_posts = [(str(r[0]), r[1] or "", r[2]) for r in list(x_posts) + list(gen_posts)]

    # ── 2. jieba posseg per post → build term→doc_set map ───────────────────
    term_docs: dict[str, set[str]] = defaultdict(set)   # term → post ids
    term_docs_4h: dict[str, set[str]] = defaultdict(set)

    cutoff_4h_naive = cutoff_4h.replace(tzinfo=None)

    for pid, content, published_at in all_posts:
        terms = _extract_terms(content)
        # published_at from SQLite may be naive UTC
        pa_naive = published_at.replace(tzinfo=None) if published_at.tzinfo else published_at
        for t in terms:
            term_docs[t].add(pid)
            if pa_naive >= cutoff_4h_naive:
                term_docs_4h[t].add(pid)

    # ── 3. Filter by cross-document frequency + upper ratio cap ─────────────
    total_posts = max(len(all_posts), 1)
    max_docs = max(MIN_DOC_FREQ, int(total_posts * MAX_DOC_RATIO))

    candidates = {
        t for t, docs in term_docs.items()
        if MIN_DOC_FREQ <= len(docs) <= max_docs
    }

    # Deduplicate English terms by lowercase (keep the cased version with more docs)
    lower_best: dict[str, str] = {}
    for t in candidates:
        lo = t.lower()
        if lo not in lower_best or len(term_docs[t]) > len(term_docs[lower_best[lo]]):
            lower_best[lo] = t
    candidates = set(lower_best.values())

    # ── 4. Load blocked terms and existing keywords ──────────────────────────
    existing_kws = (await db.execute(select(Keyword))).scalars().all()
    blocked_terms = {kw.term for kw in existing_kws if kw.blocked}
    kw_by_term = {kw.term: kw for kw in existing_kws}

    # ── 5. Upsert new auto-extracted candidates (skip blocked) ───────────────
    new_count = 0
    for term in candidates:
        if term in blocked_terms:
            continue
        if term not in kw_by_term:
            kw = Keyword(term=term, source="auto")
            db.add(kw)
            kw_by_term[term] = kw
            new_count += 1

    await db.flush()  # get IDs for new keywords

    # ── 6. Load metrics for engagement computation ───────────────────────────
    if x_posts:
        tweet_ids = [r[0] for r in x_posts]
        sub = (
            select(XPostMetrics.tweet_id, func.max(XPostMetrics.id).label("max_id"))
            .where(XPostMetrics.tweet_id.in_(tweet_ids))
            .group_by(XPostMetrics.tweet_id)
            .subquery()
        )
        metrics_rows = (await db.execute(
            select(XPostMetrics).join(sub, XPostMetrics.id == sub.c.max_id)
        )).scalars().all()
        metrics_map = {m.tweet_id: m for m in metrics_rows}
    else:
        metrics_map = {}

    def _post_engagement(pid: str) -> float:
        m = metrics_map.get(pid)
        if not m:
            return 0.0
        return m.likes + m.reposts * 2 + m.views / 100

    # ── 7. Compute heat for all active (non-blocked) keywords ────────────────
    active_kws = [kw for kw in kw_by_term.values() if not kw.blocked and kw.is_active]

    raw_heats: dict[int, float] = {}
    for kw in active_kws:
        doc_set = term_docs.get(kw.term, set())
        doc_set_4h = term_docs_4h.get(kw.term, set())

        mention_24h = len(doc_set)
        mention_4h  = len(doc_set_4h)

        avg_eng = (
            sum(_post_engagement(pid) for pid in doc_set) / mention_24h
            if mention_24h else 0.0
        )

        expected_4h = mention_24h * (4 / 24)
        velocity = mention_4h / max(expected_4h, 0.5)
        velocity = min(velocity, 3.0)

        raw = mention_24h * math.log1p(avg_eng) * velocity
        raw_heats[kw.id] = raw
        kw.mention_count_24h = mention_24h

    # Normalize to 0-100
    max_raw = max(raw_heats.values(), default=0.001)
    max_raw = max(max_raw, 0.001)

    snapshots = []
    for kw in active_kws:
        raw = raw_heats.get(kw.id, 0.0)
        new_heat = round(raw / max_raw * 100)
        old_heat = kw.heat

        if old_heat == 0 or kw.last_computed_at is None:
            kw.trend = "stable"
        elif new_heat > old_heat * 1.2:
            kw.trend = "rising"
        elif new_heat < old_heat * 0.8:
            kw.trend = "declining"
        else:
            kw.trend = "stable"

        kw.heat = new_heat
        kw.last_computed_at = now

        if mention_24h := kw.mention_count_24h:
            avg_eng = (
                sum(_post_engagement(pid) for pid in term_docs.get(kw.term, set()))
                / mention_24h
            )
        else:
            avg_eng = 0.0

        snapshots.append(KeywordSnapshot(
            keyword_id=kw.id,
            heat=new_heat,
            mention_count=kw.mention_count_24h,
            engagement_score=avg_eng,
            recorded_at=now,
        ))

    db.add_all(snapshots)
    await db.commit()

    return {"extracted": new_count, "updated": len(active_kws)}


async def get_wordcloud_data(db: AsyncSession, top_n: int = 80) -> list[dict]:
    """
    Return word cloud data directly from the keywords table.
    Weight is based on mention_count_24h (cross-document frequency).
    Only returns active, non-blocked keywords with at least 1 mention.
    """
    rows = (await db.execute(
        select(Keyword)
        .where(Keyword.is_active == True, Keyword.blocked == False,
               Keyword.mention_count_24h > 0)
        .order_by(Keyword.mention_count_24h.desc())
        .limit(top_n)
    )).scalars().all()

    if not rows:
        return []

    max_count = max(kw.mention_count_24h for kw in rows)

    return [
        {"term": kw.term, "weight": round(kw.mention_count_24h / max_count * 100)}
        for kw in rows
    ]

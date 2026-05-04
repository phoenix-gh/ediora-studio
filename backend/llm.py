"""
LLM abstraction layer.

Reads provider / model / api_key from the AppSetting table (via config.py).
Supports Anthropic (Claude) and OpenAI.
"""
import json
import anthropic
import openai

from config import get_config, effective_model, effective_base_url


async def _call(prompt: str, max_tokens: int = 2048) -> str:
    cfg = await get_config()
    provider = cfg.get("llm_provider", "anthropic")
    api_key = cfg.get("llm_api_key", "")
    model = effective_model(cfg)
    base_url = effective_base_url(cfg)

    if not api_key:
        raise RuntimeError("LLM API key not configured — please set it in Settings")

    # Anthropic uses its own SDK; everything else is OpenAI-compatible
    if provider == "anthropic" and not base_url:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        msg = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text
    else:
        kwargs: dict = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        client = openai.AsyncOpenAI(**kwargs)
        resp = await client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content or ""


def _extract_json_array(text: str) -> list:
    start = text.find("[")
    end = text.rfind("]") + 1
    if start >= 0 and end > start:
        return json.loads(text[start:end])
    return []


async def generate_topics_from_posts(posts_info: list[dict]) -> list[dict]:
    if not posts_info:
        return []

    posts_text = "\n\n".join(
        f"账号: {p['account']} ({p['platform']})\n内容: {p['content'][:300]}\n"
        f"互动: 点赞{p['likes']} 转发{p['reposts']} 评论{p['comments']}"
        for p in posts_info[:30]
    )

    prompt = f"""你是一个中文科技自媒体内容策划AI。
分析以下关注账号的最新内容，提炼出3-5个值得创作的原创选题。

最新内容:
{posts_text}

请以JSON数组格式输出选题，每个选题包含以下字段:
- title: 选题标题（简洁吸引人，20字以内）
- summary: 选题摘要（2-3句话说明核心观点和价值）
- urgency: "urgent"(24小时内)/"this_week"(本周)/"long_tail"(长尾)
- score: 推荐分数1-5
- category: 从["人工智能","芯片","开源","大模型","编程工具","操作系统","安全","区块链","量子计算"]选一个
- recommend_reason: 推荐理由（引用具体信息说明价值）
- tags: 标签数组，2-4个
- competitor_count: 预估竞品数量（整数）
- source_urls: 相关信源URL数组

只输出JSON数组。"""

    try:
        return _extract_json_array(await _call(prompt))
    except Exception as e:
        print(f"[llm] generate_topics error: {e}")
        return []


async def generate_hotspots_from_posts(posts_info: list[dict]) -> list[dict]:
    if not posts_info:
        return []

    posts_text = "\n\n".join(
        f"内容: {p['content'][:200]}\n互动: 点赞{p['likes']} 转发{p['reposts']}\n平台: {p['platform']}"
        for p in posts_info[:40]
    )

    prompt = f"""你是一个中文自媒体热点分析AI。
分析以下内容，识别当前正在发酵的热门话题。

内容:
{posts_text}

请以JSON数组格式输出5-10个热点，每个包含:
- title: 热点标题（10字以内）
- trend: "rising"/"peak"/"declining"
- heat: 热度0-100
- category: 话题分类
- platforms: 出现平台列表

只输出JSON数组。"""

    try:
        return _extract_json_array(await _call(prompt))
    except Exception as e:
        print(f"[llm] generate_hotspots error: {e}")
        return []


async def generate_economic_items(posts_info: list[dict]) -> list[dict]:
    if not posts_info:
        return []

    posts_text = "\n\n".join(
        f"来源: {p['account']}\n内容: {p['content'][:300]}"
        for p in posts_info[:30]
    )

    prompt = f"""你是一个财经经济分析AI。
从以下财经资讯中提炼关键经济动态。

内容:
{posts_text}

请以JSON数组格式输出3-8条经济动态，每条包含:
- title: 标题（15字以内）
- summary: 摘要（1-2句话）
- category: 从["宏观经济","股市行情","汇率外汇","大宗商品","科技产业","政策法规"]选一个
- impact: "positive"/"negative"/"neutral"
- impact_level: "high"/"medium"/"low"

只输出JSON数组。"""

    try:
        return _extract_json_array(await _call(prompt))
    except Exception as e:
        print(f"[llm] generate_economic error: {e}")
        return []


async def analyze_github_pain_points(owner: str, repo: str, issues: list[dict]) -> list[dict]:
    """Cluster GitHub issues into user pain points."""
    if not issues:
        return []

    issues_text = "\n".join(
        f"#{i['number']} [{','.join(i['labels'])}] 👍{i['reactions']} 💬{i['comments']}\n"
        f"  标题: {i['title']}\n"
        f"  描述: {i['body'][:300]}"
        for i in issues[:50]
    )

    prompt = f"""分析 GitHub 仓库 {owner}/{repo} 的 Issues，识别用户核心痛点和诉求。

Issues 列表（按关注度排序）:
{issues_text}

请将这些 issues 聚类归纳为 5-8 个用户痛点，以 JSON 数组输出，每项包含:
- title: 痛点标题（20字以内，直接描述问题）
- description: 详细描述（用户遇到了什么问题，影响是什么，100字以内）
- category: 分类，从 ["bug","feature","performance","ux","docs"] 选一个
- severity: 严重程度 ["high","medium","low"]，基于 reactions+comments 综合判断
- issue_count: 该痛点涉及的 issue 数量估计
- example_issues: 最具代表性的 3-5 个 issue 编号（整数数组）

只输出 JSON 数组，不要其他文字。"""

    try:
        return _extract_json_array(await _call(prompt, max_tokens=2000))
    except Exception as e:
        print(f"[llm] analyze_pain_points error: {e}")
        return []


async def generate_topics_from_x_posts(
    posts: list[dict],
    strategy: dict,
    direction_name: str,
) -> list[dict]:
    """Generate topic suggestions from X hot posts using a strategy's prompt template."""
    if not posts:
        return []

    posts_text = "\n\n".join(
        f"@{p['username']}（{p.get('display_name', '')}）\n"
        f"内容: {p['content'][:400]}\n"
        f"数据: 阅读{p.get('views', 0)} 转发{p.get('reposts', 0)} 点赞{p.get('likes', 0)} 回复{p.get('replies', 0)}"
        for p in posts[:40]
    )

    output_count = strategy.get("output_count", 5)
    custom_prompt = (strategy.get("llm_prompt") or "").strip()

    if custom_prompt:
        direction_instruction = custom_prompt
    else:
        direction_instruction = f"你负责「{direction_name}」方向的内容策划，请从该方向的视角提炼选题。"

    prompt = f"""你是一个中文自媒体内容策划 AI。
{direction_instruction}

以下是近期 X 平台的热门帖子：
{posts_text}

请提炼出 {output_count} 个适合「{direction_name}」方向创作的选题，以 JSON 数组输出，每个选题包含：
- title: 选题标题（简洁吸引人，20字以内）
- summary: 选题摘要（2-3句话说明核心观点和创作价值）
- urgency: "urgent"（24小时内）/"this_week"（本周）/"long_tail"（长尾）
- score: 推荐分数 1-5
- category: 从["人工智能","芯片","开源","大模型","编程工具","操作系统","安全","区块链","量子计算","科普","教程","热点评论"]中选一个
- recommend_reason: 推荐理由，说明为何适合「{direction_name}」方向，引用具体帖子内容
- tags: 标签数组，2-4个
- competitor_count: 预估竞品数量（整数）
- source_urls: 相关原帖URL数组

只输出 JSON 数组，不要其他文字。"""

    raw = await _call(prompt, max_tokens=3000)
    result = _extract_json_array(raw)
    if not result:
        print(f"[llm] generate_topics_from_x_posts: empty result, raw={raw[:200]}")
    return result


async def generate_article_draft(
    topic_title: str,
    topic_summary: str,
    recommend_reason: str,
    sources: list[dict],
    tags: list[str],
    persona_prompt: str = "",
) -> str:
    sources_text = "\n".join(
        f"- {s.get('title', s.get('url', ''))} [{s.get('platform', '')}]"
        for s in sources[:6]
    )

    role = persona_prompt.strip() if persona_prompt.strip() else (
        "你是一位专业的中文科技自媒体作者，擅长深度分析和独到见解。\n"
        "根据以下选题信息，撰写一篇1500-2000字的原创文章。\n\n"
        "要求:\n"
        "1. 深度分析，不简单复述\n"
        "2. 结构清晰：引人入胜开篇 → 背景 → 深度分析 → 趋势预判\n"
        "3. 专业但易读，加入独到观点\n"
        "4. 使用 ## 小标题分段\n"
        "5. 开篇直接切入核心"
    )

    prompt = f"""{role}

选题: {topic_title}
核心摘要: {topic_summary}
推荐理由: {recommend_reason}
关键词: {', '.join(tags)}
参考信源:
{sources_text}

从标题开始直接输出文章。"""

    try:
        return await _call(prompt, max_tokens=4096)
    except Exception as e:
        print(f"[llm] generate_article error: {e}")
        return ""

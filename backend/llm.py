"""
LLM abstraction layer.

Reads provider / model / api_key from the AppSetting table (via config.py).
Supports Anthropic (Claude) and OpenAI.
"""
import json
import anthropic
import openai

from config import get_config, effective_model, effective_base_url


class RefClassifyError(Exception):
    """参考文案精筛失败（LLM 调用异常 / 限流 / 安全拦截 / 返回不可解析）。
    携带人类可读原因，供采集层写入 rule.last_error 并透传到前端。"""


async def _named_session_chat(
    message: str,
    conversation: str,
    max_tokens: int = 3000,
) -> str:
    """Use OpenAI Responses API (/v1/responses) with a named conversation.
    Reads base_url / api_key / model from system config — no extra settings needed."""
    cfg = await get_config()
    api_key = cfg.get("llm_api_key", "")
    model = effective_model(cfg)
    base_url = effective_base_url(cfg)

    if not api_key:
        raise RuntimeError("LLM API key not configured")

    kwargs: dict = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url

    client = openai.AsyncOpenAI(**kwargs)
    resp = await client.responses.create(
        model=model,
        input=message,
        store=True,
        extra_body={"conversation": conversation},
    )
    # extract assistant text from output array
    for item in resp.output:
        if getattr(item, "type", None) == "message":
            for part in getattr(item, "content", []):
                if getattr(part, "type", None) == "output_text":
                    return part.text
    return resp.output_text if hasattr(resp, "output_text") else ""


async def _chat(messages: list[dict], system: str = "", max_tokens: int = 2048) -> str:
    """Multi-turn chat. messages = [{role, content}, ...]"""
    cfg = await get_config()
    provider = cfg.get("llm_provider", "anthropic")
    api_key = cfg.get("llm_api_key", "")
    model = effective_model(cfg)
    base_url = effective_base_url(cfg)

    if not api_key:
        raise RuntimeError("LLM API key not configured — please set it in Settings")

    if provider == "anthropic" and not base_url:
        client = anthropic.AsyncAnthropic(api_key=api_key)
        kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system:
            kwargs["system"] = system
        msg = await client.messages.create(**kwargs)
        return msg.content[0].text
    else:
        oai_kwargs: dict = {"api_key": api_key}
        if base_url:
            oai_kwargs["base_url"] = base_url
        client = openai.AsyncOpenAI(**oai_kwargs)
        resp = await client.responses.create(
            model=model,
            input=messages,
            instructions=system or openai.NOT_GIVEN,
            store=False,
        )
        for item in resp.output:
            if getattr(item, "type", None) == "message":
                for part in getattr(item, "content", []):
                    if getattr(part, "type", None) == "output_text":
                        return part.text
        return getattr(resp, "output_text", "")


async def _call(prompt: str, max_tokens: int = 2048) -> str:
    cfg = await get_config()
    provider = cfg.get("llm_provider", "anthropic")
    api_key = cfg.get("llm_api_key", "")
    model = effective_model(cfg)
    base_url = effective_base_url(cfg)

    if not api_key:
        raise RuntimeError("LLM API key not configured — please set it in Settings")

    # Anthropic uses its own SDK; everything else uses Chat Completions (/v1/chat/completions)
    # which is the universal OpenAI-compatible standard supported by all third-party providers.
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
        if isinstance(resp, str):
            # 代理返回 SSE keepalive + JSON；提取嵌入的响应体
            idx = resp.find('{"id":')
            if idx >= 0:
                import json as _json
                data = _json.loads(resp[idx:])
                return (data.get("choices", [{}])[0].get("message", {}).get("content") or "")
            raise RuntimeError(f"代理返回异常格式（无 JSON）：{resp[:200]}")
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


async def translate_papers(papers: list[dict]) -> list[dict]:
    """Batch translate paper titles and abstracts to Chinese.
    Input: [{arxiv_id, title, abstract}, ...]
    Output: [{arxiv_id, title_cn, abstract_cn}, ...]
    """
    if not papers:
        return []

    items_text = "\n\n".join(
        f"[{p['arxiv_id']}]\nTitle: {p['title']}\nAbstract: {p['abstract'][:800]}"
        for p in papers
    )

    prompt = f"""将以下英文学术论文的标题和摘要翻译成中文。使用以下分隔格式输出，每篇论文之间用 --- 分隔：

--- 论文分隔符 ---

[ARXIV_ID] 论文ID（原文照抄）
[TITLE_CN] 中文标题（简洁准确，保留技术术语）
[ABSTRACT_CN] 中文摘要（完整流畅，专业术语准确）

--- 论文分隔符 ---

论文列表：
{items_text}

只输出上述格式，不要其他说明文字。"""

    try:
        raw = await _call(prompt, max_tokens=8000)
        return _parse_translation_output(raw)
    except Exception as e:
        print(f"[llm] translate_papers error: {e}")
        return []


def _parse_translation_output(raw: str) -> list[dict]:
    """Parse delimiter-based translation output into list of dicts."""
    import re
    results = []
    # Split by paper delimiter
    blocks = re.split(r'-{3,}\s*(?:论文分隔符\s*)?-{0,}', raw)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        item: dict = {}
        for field in ("arxiv_id", "title_cn", "abstract_cn"):
            m = re.search(rf'\[{field.upper()}\]\s*(.+?)(?=\[(?:ARXIV_ID|TITLE_CN|ABSTRACT_CN)\]|---|\Z)', block, re.DOTALL)
            if m:
                val = m.group(1).strip()
                item[field] = val
        if item.get("arxiv_id") and item.get("title_cn"):
            results.append(item)
    return results


# 单次精筛的帖子数。整批拆小块逐块调用：避免输出超 max_tokens 被截断、
# 也缩小"一条敏感帖毒化整批"的影响面。
_REF_CLASSIFY_CHUNK = 1


async def _classify_ref_chunk(
    posts: list[dict], cat_list: str, scene_list: str,
) -> list[dict]:
    """筛一小块帖子。失败（调用异常 / 空 / 非 JSON / 解析失败）→ 抛 RefClassifyError。"""
    posts_text = "\n\n".join(
        f"[{p['source_id']}] 赞{p.get('likes', 0)}：{(p.get('text') or '')[:400]}"
        for p in posts
    )
    prompt = f"""你是中文自媒体的「参考文案」筛选与归类 AI。下面是一批 X 平台高赞帖子，
判断每条是否值得收进「参考文案库」（有梗、有共鸣、有观点、可复用为写作素材即 keep=true；
广告/带货/纯导流/无信息量/低俗无价值 → keep=false）。

帖子（格式 [id] 赞数：正文）：
{posts_text}

对每条输出一个对象，组成 JSON 数组，字段：
- source_id: 原样回传方括号里的 id（字符串）
- keep: true/false
- score: 0-100，参考价值/段子分
- category: 从[{cat_list}]中选一个；不确定填「其他」
- scene_tags: 从[{scene_list}]中选 0 个或多个（写作中的使用场景）
- tags: 2-4 个自由细标签（字符串数组）
- text_clean: 去掉 @提及/链接尾巴/多余 emoji 后的干净参考文案（保留原意）

只输出 JSON 数组，不要其他文字。"""

    # 每条输出最长可达 ~500 token（含 text_clean 全文），按块大小给足额度，避免截断。
    max_tokens = min(8000, 3000 * len(posts) + 500)
    try:
        raw = await _call(prompt, max_tokens=max_tokens)
    except Exception as e:
        raise RefClassifyError(f"LLM 调用失败：{str(e)[:200]}") from e

    raw = (raw or "").strip()
    if not raw:
        raise RefClassifyError("LLM 返回空内容（可能被安全策略拦截或限流）")

    start, end = raw.find("["), raw.rfind("]") + 1
    if not (start >= 0 and end > start):
        raise RefClassifyError(f"LLM 未返回 JSON 数组：{raw[:120]}")
    try:
        result = json.loads(raw[start:end])
    except Exception as e:
        raise RefClassifyError(f"LLM 输出 JSON 解析失败（疑似截断）：{raw[:120]}") from e
    if not isinstance(result, list):
        raise RefClassifyError("LLM 输出不是 JSON 数组")
    return result


async def classify_ref_posts(
    posts: list[dict],
    categories: list[str],
    scene_tags: list[str],
) -> list[dict]:
    """批量判定爆款帖是否值得作参考文案 + 打分 + 归类 + 标使用场景 + 清洗。
    posts[i]: {source_id, text, likes, ...}
    返回 [{source_id, keep, score, category, scene_tags, tags, text_clean}]。

    内部按 _REF_CLASSIFY_CHUNK 拆块逐块调用 LLM：
    - 任一块成功 → 累加其结果（部分成功；失败块的帖子下次重试）。
    - 全部块都失败 → 抛出第一个 RefClassifyError，供采集层写入 last_error。"""
    if not posts:
        return []

    cat_list = "、".join(categories)
    scene_list = "、".join(scene_tags)
    batch = posts[:40]

    results: list[dict] = []
    errors: list[RefClassifyError] = []
    for i in range(0, len(batch), _REF_CLASSIFY_CHUNK):
        chunk = batch[i:i + _REF_CLASSIFY_CHUNK]
        try:
            results.extend(await _classify_ref_chunk(chunk, cat_list, scene_list))
        except RefClassifyError as e:
            errors.append(e)

    if not results and errors:
        raise errors[0]
    return results

"""Application config store with in-process cache."""
import asyncio
import time
from typing import Any

from sqlalchemy import select
from database import SessionLocal
from models import AppSetting

DEFAULTS: dict[str, str] = {
    "llm_provider": "openai",
    "llm_model": "",
    "llm_api_key": "",
    "llm_base_url": "",
    "embedding_api_key": "",
    "embedding_base_url": "",
    "embedding_model": "text-embedding-3-small",
    "embedding_similarity_threshold": "0.82",
    "rsshub_base": "http://127.0.0.1:1200",
    "collect_interval_minutes": "15",
    "github_interval_minutes": "1",
    "github_trending_interval_hours": "6",
    "camofox_url": "http://localhost:9377",
    "camofox_api_key": "",
    "camofox_user_id": "wemedia_x",         # userId for the X session
    "camofox_novnc_url": "http://localhost:6080/vnc.html",  # web VNC address
    "ref_categories": "产品动态,观点争论,工具实战,翻车吐槽,数据事实,行业八卦,其他",
    "analyze_instructions": (
        "\n## 指令\n"
        "1. 读取文章，提取 3-5 个主题关键词\n"
        "2. 调 search_writing_plans 检索候选写作方案（传入关键词列表）\n"
        "3. 判断相似度：\n"
        "   - 相似且有新角度 → update_writing_plan + add_plan_update（记录新增了什么）\n"
        "   - 相似但无新内容 → add_plan_update（记录跳过原因，plan_id 取相似方案 id）\n"
        "   - 无匹配 → create_writing_plan + add_plan_update（记录新建原因）\n"
        "4. 提炼写作方案要素：\n"
        "   - 文章模式（这类文章的写法、视角、字数）\n"
        "   - 标题公式（标题结构 + 占位符举例）\n"
        "   - 找素材的方法（搜索维度、来源类型、判断标准）\n"
        "   - 禁区\n"
        "\n## 去具体化原则（必须遵守，否则方案无法复用）\n"
        "写作方案是「可重复使用的写法模板」，不是对原文章内容的复述。\n"
        "提炼时必须做到：\n"
        "- 标题公式的举例用通用占位符，不用原文的具体产品/人名/数字\n"
        "  ✅ 「[工具名] 的副作用：[问题现象]」「[平台]上有人卖 [品类]，[价格区间]，月销 [量级]+」\n"
        "  ❌ 「Vibe Coding 的副作用：...」「闲鱼上有人卖 Notion 模板，19.9 元一套」\n"
        "- 找素材的方法描述搜索「维度」和「来源类型」，不列原文章里提到的具体产品名、网站、人物\n"
        "  ✅ 「搜 [主题]+[痛点词]，来源：开发者社区一手吐槽、工具使用者维护案例」\n"
        "  ❌ 「搜 WorkBuddy、腾讯生态、Litter-tv，来源：MCP社区公告」\n"
        "- 禁区描述写法风险，不是针对某篇文章的具体说明\n"
        "检验方法：把方案交给另一个不知道原文章的人，他能否用这个方案写一篇完全不同的文章？能 → 合格。\n"
        "\n## 方案命名规范（必须遵守）\n"
        "方案名称描述「可重复使用的写法类型」，不是某篇具体文章的标题。\n"
        "✅ 正确示例：「非程序员AI工具创业故事」「普通人副业收入数字拆解」「工具对比实测横评」\n"
        "❌ 错误示例：「AI压缩产品周期：非程序员用ChatGPT做付费APP案例拆解」（这是文章标题）\n"
        "检验方法：去掉所有具体姓名/数字/工具名，剩下的还能作为一类内容的分类标签 → 合格。"
    ),
    "x_collect_interval_minutes": "15",
    "x_reply_scout_interval_minutes": "15",
    "x_reply_scout_batch": "20",
    "ref_collect_interval_minutes": "15",
    "ref_classify_interval_minutes": "60",
    "clean_batch_size": "20",
    "ref_score_scale": "18.5",
    "ref_reply_scout_threshold": "70",
    "ref_reply_min_likes": "100",
    "ref_classify_min_score": "60",
    "wechat_tunnel_enabled": "0",
    "wechat_tunnel_ssh_host": "",
    "wechat_tunnel_ssh_port": "22",
    "wechat_tunnel_ssh_user": "",
    "wechat_tunnel_ssh_key_path": "",
    "wechat_tunnel_local_host": "127.0.0.1",
    "wechat_tunnel_local_port": "18443",
    "wechat_tunnel_remote_host": "api.weixin.qq.com",
    "wechat_tunnel_remote_port": "443",
    "wechat_tunnel_extra_args": "",
    "blog_api_base": "https://mkflow.dev",
    "blog_api_token": "",          # 留空时回退环境变量 MKFLOW_AGENT_API_TOKEN
}

# Provider presets: label + default base_url + hint for default model
# Models are fetched live from the provider API, not hardcoded.
PROVIDERS: dict[str, dict[str, str]] = {
    "openai":    {"label": "OpenAI",            "base_url": "https://api.openai.com/v1",                         "default_model": "gpt-4o-mini"},
    "anthropic": {"label": "Anthropic",          "base_url": "https://api.anthropic.com",                         "default_model": "claude-3-5-haiku-20241022"},
    "deepseek":  {"label": "DeepSeek",           "base_url": "https://api.deepseek.com/v1",                       "default_model": "deepseek-chat"},
    "qwen":      {"label": "通义千问 (Qwen)",    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "default_model": "qwen-turbo"},
    "moonshot":  {"label": "Moonshot (Kimi)",    "base_url": "https://api.moonshot.cn/v1",                        "default_model": "moonshot-v1-8k"},
    "zhipu":     {"label": "智谱 (GLM)",         "base_url": "https://open.bigmodel.cn/api/paas/v4",              "default_model": "glm-4-flash"},
    "minimax":   {"label": "MiniMax (海螺)",     "base_url": "https://api.minimax.chat/v1",                       "default_model": "MiniMax-Text-01"},
    "xiaomi":    {"label": "小米 (MiMo)",        "base_url": "",                                                  "default_model": "MiMo-7B-RL"},
    "custom":    {"label": "自定义",             "base_url": "",                                                  "default_model": ""},
}


def effective_model(cfg: dict[str, str]) -> str:
    model = cfg.get("llm_model", "").strip()
    if model:
        return model
    return PROVIDERS.get(cfg.get("llm_provider", ""), {}).get("default_model", "")


def effective_base_url(cfg: dict[str, str]) -> str:
    override = cfg.get("llm_base_url", "").strip()
    if override:
        return override
    return PROVIDERS.get(cfg.get("llm_provider", ""), {}).get("base_url", "")


# ── Cache ─────────────────────────────────────────────────────────────────────

_cache: dict[str, str] = {}
_cache_ts: float = 0.0
_CACHE_TTL = 60.0
_lock = asyncio.Lock()


async def get_config() -> dict[str, str]:
    global _cache, _cache_ts
    now = time.monotonic()
    async with _lock:
        if now - _cache_ts < _CACHE_TTL and _cache:
            return dict(_cache)
        async with SessionLocal() as db:
            rows = (await db.execute(select(AppSetting))).scalars().all()
        merged = dict(DEFAULTS)
        for row in rows:
            merged[row.key] = row.value
        _cache = merged
        _cache_ts = now
        return dict(merged)


async def set_config(updates: dict[str, Any]) -> None:
    global _cache, _cache_ts
    async with SessionLocal() as db:
        for key, value in updates.items():
            row = await db.get(AppSetting, key)
            if row:
                row.value = str(value)
            else:
                db.add(AppSetting(key=key, value=str(value)))
        await db.commit()
    async with _lock:
        _cache = {}
        _cache_ts = 0.0

"""MK Flow Blog Agent Submission API 客户端。

文档：/workspace/projects/myblog/docs/agent-submission-api.md
提交的文章进入 review 状态，人工在博客后台审核后发布。
"""
import os
import re

import httpx

DEFAULT_BASE = "https://mkflow.dev"
TOKEN_ENV = "MKFLOW_AGENT_API_TOKEN"


class BlogApiError(Exception):
    """博客接口返回的业务错误（HTTP 非 2xx）。"""


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=60)


def effective_blog_config(cfg: dict) -> tuple[str, str]:
    """返回 (base_url, token)。token 优先取配置，回退环境变量。"""
    base = (cfg.get("blog_api_base") or DEFAULT_BASE).strip().rstrip("/")
    token = (cfg.get("blog_api_token") or "").strip() or os.getenv(TOKEN_ENV, "")
    return base, token


# ![alt](src) / ![alt](src "title")
_MD_IMG_RE = re.compile(r'!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)')


def extract_markdown_images(md: str) -> list[tuple[str, str]]:
    """提取 markdown 图片引用，返回 [(alt, src), ...]，src 保留原文写法。"""
    out: list[tuple[str, str]] = []
    for m in _MD_IMG_RE.finditer(md or ""):
        src = m.group(2)
        if src.startswith("<") and src.endswith(">"):
            src = src[1:-1]
        if src:
            out.append((m.group(1), src))
    return out


async def submit_post(base: str, token: str, payload: dict) -> dict:
    """POST {base}/api/agent/posts，返回响应 JSON。"""
    async with _client() as client:
        resp = await client.post(
            f"{base}/api/agent/posts",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code not in (200, 201):
        raise BlogApiError(
            (data or {}).get("error") or f"HTTP {resp.status_code}: {resp.text[:200]}"
        )
    return data or {}

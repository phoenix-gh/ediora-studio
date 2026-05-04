import math

import openai

from config import effective_base_url, get_config


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


async def embed_text(text: str) -> tuple[list[float], str]:
    cfg = await get_config()
    provider = cfg.get("llm_provider", "openai")
    api_key = (cfg.get("embedding_api_key", "") or cfg.get("llm_api_key", "")).strip()
    model = cfg.get("embedding_model", "text-embedding-3-small").strip() or "text-embedding-3-small"
    base_url = cfg.get("embedding_base_url", "").strip() or effective_base_url(cfg)

    if not api_key or (provider == "anthropic" and not cfg.get("embedding_base_url", "").strip()):
        return [], model

    kwargs: dict = {"api_key": api_key}
    if base_url:
        kwargs["base_url"] = base_url
    client = openai.AsyncOpenAI(**kwargs)
    resp = await client.embeddings.create(model=model, input=text[:6000])
    return list(resp.data[0].embedding), model


async def embedding_threshold() -> float:
    cfg = await get_config()
    try:
        return max(0.5, min(0.98, float(cfg.get("embedding_similarity_threshold", "0.82"))))
    except ValueError:
        return 0.82

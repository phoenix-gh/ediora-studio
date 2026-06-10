"""本地互动信号打分：log1p 加权 + 绝对对数刻度，跨批可比。

权重沿用 last30days signals.py 的 X 配方，外加 views 维度。
绝对刻度（而非批内 min-max）：流式采集下保证不同批次的分数语义一致。
锚点（scale=18.5，纯 likes 单维）：1 千赞≈57、1 万赞≈76、10 万赞≈95。
"""
from __future__ import annotations
import math

DEFAULT_SCALE = 18.5


def engagement_score(
    likes: int, reposts: int, replies: int, views: int,
    *, scale: float = DEFAULT_SCALE,
) -> int:
    raw = (
        0.45 * math.log1p(max(0, likes or 0))
        + 0.25 * math.log1p(max(0, reposts or 0))
        + 0.15 * math.log1p(max(0, replies or 0))
        + 0.15 * math.log1p(max(0, views or 0) / 100)
    )
    return round(min(100.0, scale * raw))

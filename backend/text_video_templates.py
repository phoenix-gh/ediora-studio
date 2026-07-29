from __future__ import annotations

from copy import deepcopy
from typing import Any


TEXT_VIDEO_TEMPLATES: dict[tuple[str, int], dict[str, Any]] = {
    ("tech-text-v1", 1): {
        "id": "tech-text-v1",
        "version": 1,
        "composition_id": "tech-text-v1",
        "aspect_ratios": ["9:16", "16:9", "1:1"],
        "animations": ["fade-up", "scale"],
        "transitions": ["soft-push"],
        "template_props": {
            "theme": ["tech-blue"],
            "font": ["source-han-sans"],
            "background": ["dark-grid"],
            "transition": ["soft-push"],
            "textDensity": ["compact", "standard", "spacious"],
        },
        "defaults": {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
    },
}


def get_text_video_template(template_id: str, version: int) -> dict[str, Any]:
    if (
        not isinstance(template_id, str)
        or not template_id.strip()
        or not isinstance(version, int)
        or isinstance(version, bool)
        or version <= 0
        or version > 9_007_199_254_740_991
    ):
        raise ValueError(f"未知文字视频模板：{template_id}@{version}")
    key = (template_id, version)
    manifest = TEXT_VIDEO_TEMPLATES.get(key)
    if manifest is None:
        raise ValueError(f"未知文字视频模板：{template_id}@{version}")
    return deepcopy(manifest)

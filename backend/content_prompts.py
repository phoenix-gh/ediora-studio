"""Prompt helpers shared by durable content-job entry points."""
from __future__ import annotations

import re


def render_profile_editor(profile: dict) -> str:
    lines = ["## 账号画像", f"- 名称：{profile.get('name', '')}", f"- 平台：{profile.get('platform', '')}"]
    for key in ("positioning", "audience", "tone", "image_style"):
        if profile.get(key): lines.append(f"- {key}：{profile[key]}")
    if profile.get("taboo"): lines.append(f"- 禁区：{'、'.join(profile['taboo'])}")
    return "\n".join(lines)


_RANGE = re.compile(r"(\d{2,4})\s*[-~–—至到]\s*(\d{2,4})\s*字")
_BOUND = re.compile(r"(?:不超过|最多|上限|≤|<=)?\s*(\d{2,4})\s*字(?:以内|以下|左右|上限)?")


def parse_word_spec(text: str) -> dict | None:
    if not text: return None
    if match := _RANGE.search(text):
        lo, hi = sorted((int(match.group(1)), int(match.group(2))))
        return {"min": lo, "max": hi, "raw": f"{lo}-{hi} 字"}
    if match := _BOUND.search(text):
        return {"min": None, "max": int(match.group(1)), "raw": f"{match.group(1)} 字以内"}
    return None


def resolve_effective_design(account_cover, account_image, plan_cover, plan_image, task_cover=None, task_image=None):
    cover = dict(account_cover or {})
    for layer in (plan_cover, task_cover):
        cover.update({k: v for k, v in (layer or {}).items() if v not in (None, "", [], {})})
    return cover, next((value for value in (task_image, plan_image, account_image) if value), "")


def plan_editor_task_block(genre_key: str, plan_id: int, word_rule_line: str) -> str:
    return f"""## 创作要求
体裁：{genre_key}；字数：{word_rule_line}。
先核实素材并形成清晰角度，再输出包含标题、核心观点、事实来源和结构的创作 brief。
写作方案 ID：{plan_id}。"""

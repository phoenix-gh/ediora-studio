"""The only model-visible operations permitted for each content step."""

from __future__ import annotations


_TOOLS_BY_STEP: dict[str, tuple[str, ...]] = {
    "brief": ("load_source", "load_account_context", "save_brief"),
    "draft": ("get_brief", "load_writing_context", "save_draft"),
    "cover": ("get_draft", "load_cover_context", "save_cover_asset"),
    "illustrations": ("get_draft", "load_image_context", "save_inline_asset"),
}


def tools_for_step(step_key: str) -> tuple[str, ...]:
    """Return a fixed allowlist; unknown steps have no model tools."""
    return _TOOLS_BY_STEP.get(step_key, ())

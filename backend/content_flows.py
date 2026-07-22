"""Deterministic content-flow declarations executed by workers."""

from __future__ import annotations

from models import ContentJob, ContentJobStep


FLOW_STEPS: dict[str, tuple[str, ...]] = {
    "draft": ("brief", "draft"),
    "cover": ("cover",),
    "illustrations": ("illustrations",),
}


def steps_for_flow(flow: str) -> tuple[str, ...]:
    return FLOW_STEPS.get(flow, ())


async def run_brief(job: ContentJob, step: ContentJobStep) -> dict:
    raise RuntimeError("brief runner is not configured")


async def run_draft(job: ContentJob, step: ContentJobStep) -> dict:
    raise RuntimeError("draft runner is not configured")


async def run_cover(job: ContentJob, step: ContentJobStep) -> dict:
    raise RuntimeError("cover runner is not configured")


async def run_illustrations(job: ContentJob, step: ContentJobStep) -> dict:
    raise RuntimeError("illustrations runner is not configured")


RUNNERS = {
    "brief": run_brief,
    "draft": run_draft,
    "cover": run_cover,
    "illustrations": run_illustrations,
}

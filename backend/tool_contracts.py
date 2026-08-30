from collections.abc import Callable
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations


EDIORA_TOOL_META_KEY = "dev.ediora/tool"

ToolNamespace = Literal[
    "information_sources",
    "web_research",
    "writing_plans",
    "drafts",
    "creative_assets",
    "image_generation",
    "accounts",
    "publishing",
    "skills",
    "system",
]
ApprovalMode = Literal["never", "writes", "always"]
ConcurrencyMode = Literal["parallel-safe", "serialized"]
RetryMode = Literal["safe", "claim-backed", "unsafe"]

_NAMESPACES = {
    "information_sources",
    "web_research",
    "writing_plans",
    "drafts",
    "creative_assets",
    "image_generation",
    "accounts",
    "publishing",
    "skills",
    "system",
}


def ediora_tool(
    mcp: FastMCP,
    *,
    namespace: ToolNamespace,
    read_only: bool,
    destructive: bool,
    idempotent: bool,
    open_world: bool,
    approval: ApprovalMode,
    concurrency: ConcurrencyMode,
    retry: RetryMode,
    version: str = "1",
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Register a FastMCP tool with Ediora's canonical execution contract."""
    if namespace not in _NAMESPACES:
        raise ValueError(f"unknown Ediora tool namespace: {namespace}")
    if not version.strip():
        raise ValueError("tool contract version is required")
    if read_only and approval != "never":
        raise ValueError("read-only tools cannot require write approval")
    if not read_only and concurrency == "parallel-safe":
        raise ValueError("write tools must be serialized")
    if destructive and read_only:
        raise ValueError("destructive tools cannot be read-only")

    return mcp.tool(
        annotations=ToolAnnotations(
            readOnlyHint=read_only,
            destructiveHint=destructive,
            idempotentHint=idempotent,
            openWorldHint=open_world,
        ),
        meta={
            EDIORA_TOOL_META_KEY: {
                "namespace": namespace,
                "version": version,
                "approval": approval,
                "concurrency": concurrency,
                "retry": retry,
            },
        },
    )

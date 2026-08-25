import asyncio

import pytest
from mcp.server.fastmcp import FastMCP


def run(coroutine):
    return asyncio.run(coroutine)


def test_ediora_tool_emits_standard_annotations_and_namespaced_metadata():
    from tool_contracts import EDIORA_TOOL_META_KEY, ediora_tool

    server = FastMCP("contract-test")

    @ediora_tool(
        server,
        namespace="drafts",
        read_only=False,
        destructive=False,
        idempotent=False,
        open_world=False,
        approval="writes",
        concurrency="serialized",
        retry="claim-backed",
    )
    async def create_test_draft(title: str) -> dict:
        """Create one test draft. Use only in this isolated contract test."""
        return {"id": 1, "title": title}

    definition = run(server.list_tools())[0]
    assert definition.annotations.model_dump(exclude_none=True) == {
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False,
    }
    assert definition.meta[EDIORA_TOOL_META_KEY] == {
        "namespace": "drafts",
        "version": "1",
        "approval": "writes",
        "concurrency": "serialized",
        "retry": "claim-backed",
    }


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"namespace": "unknown"}, "unknown Ediora tool namespace"),
        ({"version": "  "}, "tool contract version is required"),
        (
            {"read_only": True, "approval": "writes"},
            "read-only tools cannot require write approval",
        ),
        (
            {"read_only": False, "concurrency": "parallel-safe"},
            "write tools must be serialized",
        ),
        (
            {"read_only": True, "destructive": True, "approval": "never"},
            "destructive tools cannot be read-only",
        ),
    ],
)
def test_ediora_tool_rejects_inconsistent_contracts(overrides, message):
    from tool_contracts import ediora_tool

    server = FastMCP("invalid-contract-test")
    contract = {
        "namespace": "drafts",
        "read_only": False,
        "destructive": False,
        "idempotent": False,
        "open_world": False,
        "approval": "writes",
        "concurrency": "serialized",
        "retry": "claim-backed",
        "version": "1",
    }
    contract.update(overrides)

    with pytest.raises(ValueError, match=message):
        ediora_tool(server, **contract)

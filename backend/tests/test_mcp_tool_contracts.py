import asyncio
import sys

import pytest
from mcp.server.fastmcp import FastMCP


READ_TOOL_CONTRACTS = {
    "web_search": ("web_research", True),
    "fetch_url": ("web_research", True),
    "get_content_directions": ("writing_plans", False),
    "get_github_daily_trending": ("information_sources", False),
    "list_drafts": ("drafts", False),
    "get_draft": ("drafts", False),
    "search_creative_assets": ("creative_assets", False),
    "get_creative_asset": ("creative_assets", False),
    "list_source_subscriptions": ("information_sources", False),
    "search_source_items": ("information_sources", False),
    "get_source_item": ("information_sources", False),
    "list_creative_asset_candidates": ("creative_assets", False),
    "get_recent_content_usage": ("creative_assets", False),
    "list_writing_plans": ("writing_plans", False),
    "get_writing_plan": ("writing_plans", False),
    "search_writing_plans": ("writing_plans", False),
    "list_publish_accounts": ("accounts", False),
    "get_account_profile": ("accounts", False),
}

WRITE_TOOL_CONTRACTS = {
    "record_content_usage": ("creative_assets", False, True, False, "claim-backed"),
    "update_draft": ("drafts", True, False, False, "claim-backed"),
    "create_writing_plan": ("writing_plans", False, False, False, "claim-backed"),
    "add_plan_source": ("writing_plans", False, False, False, "claim-backed"),
    "update_writing_plan": ("writing_plans", True, False, False, "claim-backed"),
    "add_plan_update": ("writing_plans", False, False, False, "claim-backed"),
    "upload_image_from_url": ("creative_assets", False, False, True, "unsafe"),
    "upload_image_from_path": ("creative_assets", False, False, False, "unsafe"),
    "attach_creative_asset_to_draft": (
        "creative_assets",
        False,
        True,
        False,
        "claim-backed",
    ),
    "save_draft": ("drafts", False, False, False, "claim-backed"),
}


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def mcp_module(monkeypatch, postgres_env):
    for module_name in list(sys.modules):
        if module_name.startswith(("config", "database", "mcp_server")):
            sys.modules.pop(module_name, None)

    import mcp_server

    yield mcp_server

    from database import engine

    run(engine.dispose())


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


def test_all_read_tools_emit_explicit_contracts(mcp_module):
    from tool_contracts import EDIORA_TOOL_META_KEY

    definitions = {tool.name: tool for tool in run(mcp_module.mcp.list_tools())}

    assert READ_TOOL_CONTRACTS.keys() <= definitions.keys()
    for name, (namespace, open_world) in READ_TOOL_CONTRACTS.items():
        definition = definitions[name]
        assert definition.annotations.model_dump(exclude_none=True) == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": open_world,
        }
        assert definition.meta[EDIORA_TOOL_META_KEY] == {
            "namespace": namespace,
            "version": "1",
            "approval": "never",
            "concurrency": "parallel-safe",
            "retry": "safe",
        }


def test_read_tool_descriptions_define_selection_boundaries(mcp_module):
    definitions = run(mcp_module.mcp.list_tools())
    descriptions = {tool.name: tool.description.lower() for tool in definitions}

    assert "not random" in descriptions["search_source_items"]
    assert "known id" in descriptions["get_source_item"]
    assert "not stored ediora" in descriptions["web_search"]
    assert "not x subscription" in descriptions["get_github_daily_trending"]
    assert "not user-managed writing plans" in descriptions["get_content_directions"]


def test_all_write_tools_emit_explicit_contracts(mcp_module):
    from tool_contracts import EDIORA_TOOL_META_KEY

    definitions = {tool.name: tool for tool in run(mcp_module.mcp.list_tools())}

    assert set(definitions) == set(READ_TOOL_CONTRACTS) | set(WRITE_TOOL_CONTRACTS)
    for name, contract in WRITE_TOOL_CONTRACTS.items():
        namespace, destructive, idempotent, open_world, retry = contract
        definition = definitions[name]
        assert definition.annotations.model_dump(exclude_none=True) == {
            "readOnlyHint": False,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": open_world,
        }
        assert definition.meta[EDIORA_TOOL_META_KEY] == {
            "namespace": namespace,
            "version": "1",
            "approval": "writes",
            "concurrency": "serialized",
            "retry": retry,
        }

    assert definitions["attach_creative_asset_to_draft"].annotations.idempotentHint is True
    assert definitions["update_draft"].annotations.destructiveHint is True
    assert definitions["upload_image_from_url"].annotations.openWorldHint is True
    assert definitions["save_draft"].meta[EDIORA_TOOL_META_KEY]["approval"] == "writes"

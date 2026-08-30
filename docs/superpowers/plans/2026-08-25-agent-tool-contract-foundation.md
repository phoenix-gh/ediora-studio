# Agent Tool Contract Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a canonical, inspectable Tool Contract Registry for every current MCP and native Agent tool without changing which user requests can execute.

**Architecture:** FastMCP tools emit standard MCP annotations plus namespaced Ediora execution metadata. The Next.js Agent runtime reads raw MCP definitions, pairs them with AI SDK executables, normalizes MCP and native tools into one registry, and uses explicit contracts for policy and capability snapshots while retaining a warning-producing compatibility fallback for third-party or legacy tools.

**Tech Stack:** Python 3.11+, FastMCP/MCP 1.x, Pydantic v2, TypeScript 5, Next.js 16, Vercel AI SDK 7, `@ai-sdk/mcp` 2, Zod 4, pytest, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-agent-capability-harness-design.md`

## Global Constraints

- Tool Registry is the source of truth for executable capabilities; do not add a duplicate business-capability database.
- Phase 1 preserves current callable-tool behavior; progressive discovery and plan compilation belong to later plans.
- New or migrated first-party tools declare namespace, safety, replay, concurrency, and approval metadata explicitly.
- Name-based inference remains only as a warning-producing compatibility fallback.
- Input constraints stay in JSON Schema; descriptions explain selection boundaries and result evidence.
- Phase 1 preserves legacy parameter acceptance: it records and digests current schemas and protects existing machine-readable enums; tightening free-form legacy parameters requires a later versioned Tool Contract change.
- Skills describe workflows and may request tools, but they do not duplicate tool schemas or grant authority.
- Every new Chat turn recomputes callable tools; no Tool Contract grants reusable permission.
- Use Ediora in new product-facing names and prose; keep WeMediaStudio only in legacy paths and compatibility identifiers.
- Use `/home/violet/miniconda3/envs/wems/bin/python -m pytest` for backend tests.
- Run focused frontend tests from `web` with `pnpm exec vitest run` followed by the explicitly listed test files; do not invoke the full suite unless focused coverage is inadequate.
- Each task follows red-green-refactor and ends with its own commit.

## Scope Boundary

This plan implements Phase 1, the Tool Contract foundation. It deliberately does not implement namespace routing, tool search, persisted Agent plans, objective validators, replanning, or the missing `sample_source_items` business primitive. It also does not tighten legacy free-form parameters whose accepted values are inconsistent across current consumers; those changes require a version increment and targeted compatibility tests. Those are independently releasable follow-up plans after the Registry is trustworthy.

## File Map

### New files

- `backend/tool_contracts.py` — FastMCP decorator helper, standard annotations, and Ediora `_meta` validation.
- `backend/tests/test_mcp_tool_contracts.py` — exhaustive first-party MCP contract inventory and description-boundary assertions.
- `web/lib/ai/tool-contract.ts` — canonical TypeScript contract types, native/MCP normalization, digesting, and legacy fallback.
- `web/lib/ai/tool-contract.test.ts` — normalization, metadata validation, digest, and fallback tests.
- `web/lib/ai/tool-registry.ts` — executable/contract pairing and Registry diagnostics.
- `web/lib/ai/tool-registry.test.ts` — duplicate, missing, invalid, filtered, and native-tool Registry tests.

### Modified files

- `backend/mcp_server.py` — register all 28 MCP tools with explicit metadata and sharpen adjacent-tool descriptions.
- `web/lib/ai/global-chat-tools.ts` — read raw MCP definitions, build executables from those definitions, register native tools, and expose the normalized Registry.
- `web/lib/ai/global-chat-tools.test.ts` — mock `listTools`/`toolsFromDefinitions` and verify Registry propagation without changing the callable set.
- `web/lib/ai/agent-tool-policy.ts` — consume explicit contracts for approval, serialization, and replay policy; retain legacy fallback.
- `web/lib/ai/agent-tool-policy.test.ts` — prove explicit metadata overrides misleading tool names and fallback remains conservative.
- `web/lib/ai/agent-capabilities.ts` — add optional contract fields to snapshots and digest contracts from the Registry.
- `web/lib/ai/agent-capabilities.test.ts` — verify new snapshots, old-snapshot compatibility, and contract drift.
- `web/lib/ai/agent-runtime.ts` — pass visible Tool Contracts to policy and snapshot builders, including the native `complete_goal` control tool.
- `web/lib/ai/agent-runtime.test.ts` — verify visible contracts follow allowlists and control tools stay scoped.

---

### Task 1: Add the FastMCP Tool Contract decorator

**Files:**
- Create: `backend/tool_contracts.py`
- Create: `backend/tests/test_mcp_tool_contracts.py`

**Interfaces:**
- Consumes: `mcp.server.fastmcp.FastMCP`, `mcp.types.ToolAnnotations`.
- Produces: `EDIORA_TOOL_META_KEY`, `ToolNamespace`, `ApprovalMode`, `ConcurrencyMode`, `RetryMode`, and `ediora_tool(mcp, *, namespace, read_only, destructive, idempotent, open_world, approval, concurrency, retry, version="1")`.

- [ ] **Step 1: Write a failing decorator contract test**

Create an isolated FastMCP instance in `backend/tests/test_mcp_tool_contracts.py` and assert the emitted MCP definition:

```python
import asyncio

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
```

Also add parametrized rejection cases for unknown namespace, `read_only=True` with `approval="writes"`, and `concurrency="parallel-safe"` on a write.

- [ ] **Step 2: Run the test and verify it fails**

Run from the repository root:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_tool_contracts.py -q
```

Expected: FAIL because `backend/tool_contracts.py` does not exist.

- [ ] **Step 3: Implement the decorator and validation**

Create `backend/tool_contracts.py` with literal types and fail-fast validation:

```python
from collections.abc import Callable
from typing import Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

EDIORA_TOOL_META_KEY = "dev.ediora/tool"

ToolNamespace = Literal[
    "information_sources", "web_research", "writing_plans", "drafts",
    "creative_assets", "image_generation", "accounts", "publishing",
    "skills", "system",
]
ApprovalMode = Literal["never", "writes", "always"]
ConcurrencyMode = Literal["parallel-safe", "serialized"]
RetryMode = Literal["safe", "claim-backed", "unsafe"]

_NAMESPACES = {
    "information_sources", "web_research", "writing_plans", "drafts",
    "creative_assets", "image_generation", "accounts", "publishing",
    "skills", "system",
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run the same pytest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tool_contracts.py backend/tests/test_mcp_tool_contracts.py
git commit -m "feat: define MCP tool contracts"
```

---

### Task 2: Annotate read-only MCP tools and sharpen selection boundaries

**Files:**
- Modify: `backend/mcp_server.py:13-527,640-970,1419-1483`
- Modify: `backend/tests/test_mcp_tool_contracts.py`

**Interfaces:**
- Consumes: `ediora_tool` from Task 1.
- Produces: explicit contracts for all 18 read-only MCP tools and model-facing descriptions that distinguish list/search/get/sample/trending semantics.

Use this exact contract matrix:

| Tool | Namespace | Open world | Description boundary |
|---|---|---:|---|
| `web_search` | `web_research` | yes | public search; not stored Ediora sources |
| `fetch_url` | `web_research` | yes | known public URL; not search |
| `get_content_directions` | `writing_plans` | no | editorial directions/strategies; not user writing plans |
| `get_github_daily_trending` | `information_sources` | no | collected GitHub daily ranking; not X subscription content |
| `list_drafts` | `drafts` | no | compact draft discovery; not full content |
| `get_draft` | `drafts` | no | full draft by known ID; not search |
| `search_creative_assets` | `creative_assets` | no | general asset search; not scheduled-directory candidate selection |
| `get_creative_asset` | `creative_assets` | no | full asset by known ID |
| `list_source_subscriptions` | `information_sources` | no | resolve subscription IDs/names; never collect items |
| `search_source_items` | `information_sources` | no | relevance/filter search over stored items; not random sampling |
| `get_source_item` | `information_sources` | no | full stored item by source type and known ID |
| `list_creative_asset_candidates` | `creative_assets` | no | compact scheduled-creation candidates from explicit directories |
| `get_recent_content_usage` | `creative_assets` | no | prior-use evidence for deduplication; not asset search |
| `list_writing_plans` | `writing_plans` | no | compact plan discovery |
| `get_writing_plan` | `writing_plans` | no | full plan by known ID |
| `search_writing_plans` | `writing_plans` | no | keyword plan search; not source-item search |
| `list_publish_accounts` | `accounts` | no | compact account discovery |
| `get_account_profile` | `accounts` | no | full profile by known account ID |

All rows use `read_only=True`, `destructive=False`, `idempotent=True`, `approval="never"`, `concurrency="parallel-safe"`, and `retry="safe"`.

- [ ] **Step 1: Add a failing exhaustive read-contract test**

In `backend/tests/test_mcp_tool_contracts.py`, import `mcp_server`, read `await mcp.list_tools()`, and assert every row above has the exact namespace and standard annotations. Assert the set contains all 18 names in the matrix so a forgotten decorator fails loudly.

Add focused description assertions:

```python
assert "not random" in descriptions["search_source_items"].lower()
assert "known id" in descriptions["get_source_item"].lower()
assert "not stored ediora" in descriptions["web_search"].lower()
assert "not x subscription" in descriptions["get_github_daily_trending"].lower()
assert "not user-managed writing plans" in descriptions["get_content_directions"].lower()
```

- [ ] **Step 2: Run the focused backend test and verify it fails**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_tool_contracts.py -q
```

Expected: FAIL because current definitions have no annotations or Ediora metadata.

- [ ] **Step 3: Replace the 18 read decorators and edit their docstrings**

Import `ediora_tool` next to the MCP imports. Replace each `@mcp.tool()` with the matrix-backed decorator. Use this pattern:

```python
@ediora_tool(
    mcp,
    namespace="information_sources",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def search_source_items(
    source_type: str = "",
    query: str = "",
    subscription_id: Optional[str] = None,
    days: int = 30,
    limit: int = 20,
) -> list[dict]:
    """Search collected Ediora source items by relevance and filters.

    Use for keyword, source-type, subscription, or date filtering over stored
    items. This is not random sampling and does not access the public web or
    trigger collection. Call get_source_item with a returned source type and
    known ID when the complete stored body is required.
    """
```

Apply the exact boundary text from the table to each tool without changing its parameters or implementation.

- [ ] **Step 4: Run related MCP contract regressions**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_tool_contracts.py \
  backend/tests/test_mcp_source_tools.py \
  backend/tests/test_mcp_github_trending_tools.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server.py backend/tests/test_mcp_tool_contracts.py
git commit -m "feat: annotate read-only MCP tools"
```

---

### Task 3: Annotate write MCP tools and preserve existing approval behavior

**Files:**
- Modify: `backend/mcp_server.py:548-639,775-911,970-1418`
- Modify: `backend/tests/test_mcp_tool_contracts.py`

**Interfaces:**
- Consumes: `ediora_tool` and the read contract inventory.
- Produces: explicit contracts for all 10 current write tools.

Use this exact write matrix:

| Tool | Namespace | Destructive | Idempotent | Open world | Retry |
|---|---|---:|---:|---:|---|
| `record_content_usage` | `creative_assets` | no | yes | no | `claim-backed` |
| `update_draft` | `drafts` | yes | no | no | `claim-backed` |
| `create_writing_plan` | `writing_plans` | no | no | no | `claim-backed` |
| `add_plan_source` | `writing_plans` | no | no | no | `claim-backed` |
| `update_writing_plan` | `writing_plans` | yes | no | no | `claim-backed` |
| `add_plan_update` | `writing_plans` | no | no | no | `claim-backed` |
| `upload_image_from_url` | `creative_assets` | no | no | yes | `unsafe` |
| `upload_image_from_path` | `creative_assets` | no | no | no | `unsafe` |
| `attach_creative_asset_to_draft` | `creative_assets` | no | yes | no | `claim-backed` |
| `save_draft` | `drafts` | no | no | no | `claim-backed` |

All rows use `read_only=False`, `approval="writes"`, and `concurrency="serialized"`.

- [ ] **Step 1: Add a failing exhaustive write-contract test**

Assert every matrix row has the exact standard annotations and Ediora metadata. Add these behavioral alignment assertions:

```python
assert contracts["attach_creative_asset_to_draft"].annotations.idempotentHint is True
assert contracts["update_draft"].annotations.destructiveHint is True
assert contracts["upload_image_from_url"].annotations.openWorldHint is True
assert contracts["save_draft"].meta[EDIORA_TOOL_META_KEY]["approval"] == "writes"
```

Assert the union of the read and write inventories equals the complete set returned by `mcp.list_tools()` so every first-party MCP tool is covered.

- [ ] **Step 2: Run the test and verify it fails**

Run `backend/tests/test_mcp_tool_contracts.py`. Expected: FAIL on the first unannotated write tool.

- [ ] **Step 3: Replace write decorators without changing handlers**

Apply the exact matrix. Improve each write description to name the created or overwritten artifact, required IDs, idempotency behavior, and returned evidence. Do not fix unrelated handler behavior, database logic, or the existing public API in this task.

Use this pattern for an idempotent write:

```python
@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=False,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def attach_creative_asset_to_draft(
    draft_id: int,
    asset_id: int,
) -> dict:
    """Attach one existing local image asset to a known draft.

    Use only after both IDs are known. Repeating the same draft/asset pair
    returns the existing DraftImage, so no duplicate attachment is created.
    This does not download, generate, or copy an image. Returns the persistent
    draft_image_id, draft_id, asset_id, URL, filename, size, and MIME type.
    """
```

- [ ] **Step 4: Run write-tool regressions**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_tool_contracts.py \
  backend/tests/test_mcp_daily_creation_tools.py \
  backend/tests/test_mcp_creative_asset_tools.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/mcp_server.py backend/tests/test_mcp_tool_contracts.py
git commit -m "feat: annotate MCP write tools"
```

---

### Task 4: Normalize MCP and native contracts in TypeScript

**Files:**
- Create: `web/lib/ai/tool-contract.ts`
- Create: `web/lib/ai/tool-contract.test.ts`
- Modify: `web/lib/ai/agent-capabilities.ts:1-119`

**Interfaces:**
- Consumes: `ListToolsResult` from `@ai-sdk/mcp`, AI SDK `ToolSet`, existing `stableJson`/`sha256Text` behavior.
- Produces: `TOOL_NAMESPACES`, `ToolNamespace`, `ToolContract`, `ToolContractMetadata`, `ToolContractDiagnostic`, `normalizeMcpToolContract`, `normalizeNativeToolContract`, `legacyToolContract`, and `contractDigest`.

- [ ] **Step 1: Write failing normalization tests**

Create `web/lib/ai/tool-contract.test.ts` with a realistic MCP definition:

```ts
const definition = {
  name: 'get_draft',
  description: 'Read one full draft by known ID.',
  inputSchema: {
    type: 'object' as const,
    properties: { draft_id: { type: 'integer' } },
    required: ['draft_id'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    'dev.ediora/tool': {
      namespace: 'drafts', version: '1', approval: 'never',
      concurrency: 'parallel-safe', retry: 'safe',
    },
  },
}
```

Assert normalization preserves the input schema, yields `availability: "available"`, and produces the same digest for object keys in a different order. Add failures for missing description, unknown namespace, incomplete annotations, and `readOnly=true` combined with `approval="writes"`.

Add a legacy fallback test asserting `save_legacy_record` becomes a serialized, claim-backed write with a `legacy-contract` warning rather than read-only.

- [ ] **Step 2: Run the focused Vitest file and verify it fails**

From `web`:

```bash
pnpm exec vitest run lib/ai/tool-contract.test.ts
```

Expected: FAIL because `tool-contract.ts` does not exist.

- [ ] **Step 3: Implement canonical types and normalization**

Move `stableJson` and `sha256Text` from `agent-capabilities.ts` into `tool-contract.ts` and re-export them so existing imports remain explicit. Define:

```ts
export const TOOL_NAMESPACES = [
  'information_sources', 'web_research', 'writing_plans', 'drafts',
  'creative_assets', 'image_generation', 'accounts', 'publishing',
  'skills', 'system',
] as const

export type ToolContract = {
  name: string
  namespace: ToolNamespace
  version: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations: {
    readOnly: boolean
    destructive: boolean
    idempotent: boolean
    openWorld: boolean
    approval: 'never' | 'writes' | 'always'
  }
  execution: {
    concurrency: 'parallel-safe' | 'serialized'
    retry: 'safe' | 'claim-backed' | 'unsafe'
  }
  availability: 'available' | 'unavailable'
  contractDigest: string
  source: 'mcp' | 'native' | 'legacy'
}

export type ToolContractMetadata = {
  namespace: ToolNamespace
  version: string
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  openWorld: boolean
  approval: 'never' | 'writes' | 'always'
  concurrency: 'parallel-safe' | 'serialized'
  retry: 'safe' | 'claim-backed' | 'unsafe'
}

export type ToolContractDiagnostic = {
  toolName: string
  severity: 'warning' | 'error'
  code: 'legacy-contract' | 'invalid-contract' | 'missing-executable' | 'duplicate-tool'
  message: string
}

export type ToolContractNormalization = {
  contract?: ToolContract
  diagnostics: ToolContractDiagnostic[]
}
```

Derive `McpToolDefinition` as `ListToolsResult['tools'][number]`; do not import internal package paths. Hash a canonical object that excludes `availability` and diagnostics but includes name, namespace, version, description, schemas, annotations, and execution metadata.

Expose these exact normalizer signatures:

```ts
export function normalizeMcpToolContract(
  definition: ListToolsResult['tools'][number],
): ToolContractNormalization

export function normalizeNativeToolContract(
  name: string,
  value: ToolSet[string],
  metadata: ToolContractMetadata,
): ToolContractNormalization

export function legacyToolContract(
  name: string,
  value: ToolSet[string],
): ToolContractNormalization
```

For native contracts, require the metadata fields explicitly and read description/input/output schemas from the actual AI SDK tool. For legacy fallback, preserve the current conservative name predicate in this module and return a `legacy-contract` diagnostic.

- [ ] **Step 4: Update capability utility imports and run tests**

Change `agent-capabilities.ts` to import `stableJson` and `sha256Text` from `./tool-contract`. Run:

```bash
pnpm exec vitest run \
  lib/ai/tool-contract.test.ts \
  lib/ai/agent-capabilities.test.ts
```

Expected: PASS with no behavior change in existing capability tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/tool-contract.ts web/lib/ai/tool-contract.test.ts \
  web/lib/ai/agent-capabilities.ts
git commit -m "feat: normalize agent tool contracts"
```

---

### Task 5: Build the executable Tool Registry and diagnostics

**Files:**
- Create: `web/lib/ai/tool-registry.ts`
- Create: `web/lib/ai/tool-registry.test.ts`

**Interfaces:**
- Consumes: `ToolContract` normalization from Task 4, MCP `ListToolsResult`, and AI SDK `ToolSet`.
- Produces: `ToolRegistry`, `buildToolRegistry`, `contractsForTools`, `registryContractRecord`, and deterministic diagnostics.

- [ ] **Step 1: Write failing Registry tests**

Test these cases with small fake definitions and executable tools:

1. MCP definition and executable pair produce one Registry entry.
2. Native registration produces one Registry entry.
3. A blocked tool removed from both definition and executable inputs is absent.
4. Duplicate native/MCP names are rejected.
5. An executable without a definition or native contract is included only in compatibility mode and emits `legacy-contract`.
6. Strict mode excludes invalid/missing contracts.
7. Registry entries and diagnostics sort by tool name for stable snapshots.

Assert this interface:

```ts
export type ToolRegistry = {
  tools: ToolSet
  contracts: ReadonlyMap<string, ToolContract>
  diagnostics: readonly ToolContractDiagnostic[]
  get(name: string): { tool: ToolSet[string]; contract: ToolContract } | undefined
}
```

- [ ] **Step 2: Run and verify the test fails**

```bash
pnpm exec vitest run lib/ai/tool-registry.test.ts
```

Expected: FAIL because the Registry module does not exist.

- [ ] **Step 3: Implement deterministic pairing**

Implement:

```ts
export function buildToolRegistry(input: {
  tools: ToolSet
  mcpDefinitions?: ListToolsResult['tools']
  nativeContracts?: Readonly<Record<string, ToolContractMetadata>>
  compatibilityMode?: boolean
}): ToolRegistry
```

Pair by exact tool name. Reject duplicate definitions. For an MCP definition, normalize its raw annotations and `_meta`; for a named native entry, normalize the actual AI SDK tool plus metadata. When `compatibilityMode` is true, use `legacyToolContract`; otherwise record an error and exclude the tool. Never manufacture an executable for a definition that lacks one.

Implement `contractsForTools(registry, names)` so later allowlist code gets a filtered `ReadonlyMap` without changing contracts.

- [ ] **Step 4: Run contract and Registry tests**

```bash
pnpm exec vitest run \
  lib/ai/tool-contract.test.ts \
  lib/ai/tool-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/tool-registry.ts web/lib/ai/tool-registry.test.ts
git commit -m "feat: add agent tool registry"
```

---

### Task 6: Register raw MCP definitions and native tools in global Chat

**Files:**
- Modify: `web/lib/ai/global-chat-tools.ts:1-345`
- Modify: `web/lib/ai/global-chat-tools.test.ts:1-380`

**Interfaces:**
- Consumes: `buildToolRegistry`, `ToolRegistry`, `client.listTools()`, and `client.toolsFromDefinitions()`.
- Produces: `ChatSkillRuntime.toolRegistry()`, explicit native contracts for `generateImage`, `loadSkill`, and `readSkillReference`, and unchanged callable tools.

- [ ] **Step 1: Change the MCP mock and add failing integration assertions**

Replace the current `mcp.tools` mock with:

```ts
const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  toolsFromDefinitions: vi.fn(),
  close: vi.fn(),
}))
```

Mock `createMCPClient` with those methods. Add a test that returns one annotated `list_items` definition, pairs it with a fake executable, opens global tools, and asserts:

```ts
expect(runtime.toolRegistry().contracts.get('list_items')).toMatchObject({
  namespace: 'information_sources',
  source: 'mcp',
  annotations: { readOnly: true, approval: 'never' },
})
expect(Object.keys(runtime.tools)).toEqual(expect.arrayContaining([
  'list_items', 'generateImage', 'loadSkill', 'readSkillReference',
]))
```

Add a scheduled-mode assertion that blocked upload tools are absent from both `runtime.tools` and `runtime.toolRegistry().contracts`.

- [ ] **Step 2: Run the integration test and verify it fails**

```bash
pnpm exec vitest run lib/ai/global-chat-tools.test.ts
```

Expected: FAIL because production still calls `client.tools()` and exposes no Registry.

- [ ] **Step 3: Add explicit native contract constants**

Define native metadata next to the native tool schemas:

```ts
const NATIVE_TOOL_CONTRACTS = {
  generateImage: {
    namespace: 'image_generation', version: '1',
    readOnly: false, destructive: false, idempotent: false, openWorld: true,
    approval: 'never', concurrency: 'serialized', retry: 'unsafe',
  },
  loadSkill: {
    namespace: 'skills', version: '1',
    readOnly: true, destructive: false, idempotent: true, openWorld: false,
    approval: 'never', concurrency: 'serialized', retry: 'safe',
  },
  readSkillReference: {
    namespace: 'skills', version: '1',
    readOnly: true, destructive: false, idempotent: true, openWorld: false,
    approval: 'never', concurrency: 'parallel-safe', retry: 'safe',
  },
} satisfies Record<string, ToolContractMetadata>
```

Only pass entries for native tools actually present in `runtime.tools`; `loadSkill` is absent when a Skill is already active.

- [ ] **Step 4: Discover once and build the Registry**

Replace `client.tools()` with one raw discovery call:

```ts
const definitions = await client.listTools()
const discovered = client.toolsFromDefinitions(definitions)
```

Filter blocked names from both `definitions.tools` and `discovered`. First build a base Registry from the filtered MCP tools plus `generateImage`. Pass that Registry to `createChatSkillRuntime` as `baseToolRegistry`; after it adds the conditional `loadSkill` and the always-present `readSkillReference`, rebuild the Registry with only the native contracts that correspond to present tools. Extend `ChatSkillRuntime` with `toolRegistry(): ToolRegistry`. When `createChatSkillRuntime` is called directly without a base Registry, build a compatibility-mode Registry from `baseTools` so existing callers and tests remain valid. Preserve the current tool objects and policy wrapping so Phase 1 changes metadata, not user-visible availability.

- [ ] **Step 5: Run global tool and Skill regressions**

```bash
pnpm exec vitest run \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/chat-tools.test.ts \
  lib/skills/registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/ai/global-chat-tools.ts web/lib/ai/global-chat-tools.test.ts
git commit -m "feat: register global agent tool contracts"
```

---

### Task 7: Drive policy from explicit contracts with a legacy fallback

**Files:**
- Modify: `web/lib/ai/agent-tool-policy.ts:1-269`
- Modify: `web/lib/ai/agent-tool-policy.test.ts`
- Modify: `web/lib/ai/global-chat-tools.ts:280-345`

**Interfaces:**
- Consumes: `ReadonlyMap<string, ToolContract>` from the Registry.
- Produces: `requiresToolApproval(name, contract?)`, `toolExecutionMetadata(name, contract?)`, and contract-aware `applyAgentToolPolicy` options.

- [ ] **Step 1: Add failing explicit-policy tests**

Add a `contract()` fixture and prove semantics override misleading names:

```ts
import type { ToolContract } from './tool-contract'

function contract(overrides: Partial<ToolContract['annotations']>): ToolContract {
  const annotations = {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    approval: 'never' as const,
    ...overrides,
  }
  return {
    name: 'test_tool',
    namespace: 'system',
    version: '1',
    description: 'Test one explicit policy contract.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations,
    execution: annotations.readOnly
      ? { concurrency: 'parallel-safe', retry: 'safe' }
      : { concurrency: 'serialized', retry: 'claim-backed' },
    availability: 'available',
    contractDigest: 'a'.repeat(64),
    source: 'native',
  }
}

expect(requiresToolApproval(
  'get_but_actually_writes',
  contract({ readOnly: false, idempotent: false, approval: 'writes' }),
)).toBe(true)

expect(requiresToolApproval(
  'save_but_read_only',
  contract({ readOnly: true, approval: 'never' }),
)).toBe(false)
```

Assert a contract marked `parallel-safe` actually runs concurrently even when its name lacks a read prefix, and a `serialized` contract remains serialized. Keep an existing test proving an unknown legacy `save_item` is conservatively gated.

- [ ] **Step 2: Run and verify failures**

```bash
pnpm exec vitest run lib/ai/agent-tool-policy.test.ts
```

Expected: FAIL because current policy accepts only names.

- [ ] **Step 3: Implement contract-first policy**

Extend `AgentToolPolicyOptions`:

```ts
export type AgentToolPolicyOptions = {
  policy: AgentApprovalPolicy
  contracts?: ReadonlyMap<string, ToolContract>
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onAudit?: (event: AgentToolAudit) => void | Promise<void>
}
```

Use contract annotations when present. Compute `sideEffecting` from `readOnly`, independently from approval. This records `generateImage` as a side effect while retaining its `approval="never"` behavior. `approval="always"` requires approval even under the automatic profile; `approval="writes"` follows the current interactive/automatic behavior; `approval="never"` never prompts. Derive concurrency from the contract and map retry modes to the existing idempotency policy: `safe -> replayable`, `claim-backed -> claim-backed`, and `unsafe -> unknown`. Fall back to `legacyToolContract` only when the map has no entry.

Pass `runtime.toolRegistry().contracts` from `openGlobalAgentTools` into `applyAgentToolPolicy`.

- [ ] **Step 4: Run policy and global-tool regressions**

```bash
pnpm exec vitest run \
  lib/ai/agent-tool-policy.test.ts \
  lib/ai/global-chat-tools.test.ts
```

Expected: PASS and existing automatic/interative behavior remains unchanged for current tools.

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/agent-tool-policy.ts web/lib/ai/agent-tool-policy.test.ts \
  web/lib/ai/global-chat-tools.ts
git commit -m "feat: enforce explicit agent tool policy"
```

---

### Task 8: Record Tool Contracts in capability snapshots without breaking old jobs

**Files:**
- Modify: `web/lib/ai/agent-capabilities.ts:21-278`
- Modify: `web/lib/ai/agent-capabilities.test.ts`
- Modify: `web/lib/ai/agent-runtime.ts:280-342`
- Modify: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Consumes: Registry contract maps and existing schema-version-1 snapshots.
- Produces: optional `namespace`, `version`, `outputSchemaDigest`, `contractDigest`, and `availability` fields in `ToolCapabilityDescriptor`; contract-aware snapshot construction and backward-compatible drift detection.

- [ ] **Step 1: Add failing snapshot tests**

Add tests asserting a new snapshot contains:

```ts
expect(snapshot.tools[0]).toMatchObject({
  name: 'get_draft',
  namespace: 'drafts',
  version: '1',
  contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  availability: 'available',
  sideEffecting: false,
  replayPolicy: 'replayable',
})
```

Add three compatibility cases:

1. an old schema-version-1 snapshot without new fields pins successfully;
2. two new snapshots with the same digest pin successfully;
3. two new snapshots with different contract digests report `tools` drift.

Add an Agent runtime test showing a profile allowlist filters both visible tools and the contracts used in its capability snapshot.

- [ ] **Step 2: Run and verify failures**

```bash
pnpm exec vitest run \
  lib/ai/agent-capabilities.test.ts \
  lib/ai/agent-runtime.test.ts
```

Expected: FAIL because snapshots do not accept Registry contracts.

- [ ] **Step 3: Extend descriptors compatibly**

Keep `schemaVersion: 1` during Phase 1. Add the new fields as optional so persisted snapshots remain readable:

```ts
export type ToolCapabilityDescriptor = {
  name: string
  description: string
  inputSchemaDigest: string | null
  outputSchemaDigest?: string | null
  namespace?: ToolNamespace
  version?: string
  contractDigest?: string
  availability?: 'available' | 'unavailable'
  sideEffecting: boolean
  needsApproval: boolean
  replayPolicy: 'replayable' | 'uncertain-on-interruption'
  concurrencyPolicy: 'parallel-safe' | 'serialized' | 'unknown'
  idempotencyPolicy: 'replayable' | 'claim-backed' | 'unknown'
}
```

Extend `buildAgentCapabilitySnapshot` with `contracts?: ReadonlyMap<string, ToolContract>`. When a contract exists, populate the new fields and derive safety/execution values from it. When absent, preserve current legacy behavior.

In drift comparison, compare each new field only when both expected and actual descriptors define it. This lets old running jobs continue while ensuring new jobs detect contract changes.

- [ ] **Step 4: Pass filtered contracts through Agent runtime**

Use `registry.toolRegistry()` to obtain contracts, filter them with the same `allowedToolNames` used by `visibleTools()`, and pass them to the snapshot builder. Define an explicit `complete_goal` native contract in `agent-runtime.ts` under namespace `system`; pass it to its policy wrapper while keeping it excluded from the ordinary visible-tool snapshot as existing tests require.

- [ ] **Step 5: Run capability and runtime regressions**

```bash
pnpm exec vitest run \
  lib/ai/tool-contract.test.ts \
  lib/ai/tool-registry.test.ts \
  lib/ai/agent-capabilities.test.ts \
  lib/ai/agent-tool-policy.test.ts \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/agent-runtime.test.ts \
  lib/ai/pipeline-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/lib/ai/agent-capabilities.ts web/lib/ai/agent-capabilities.test.ts \
  web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime.test.ts
git commit -m "feat: snapshot agent tool contracts"
```

---

### Task 9: Verify the complete Phase 1 contract foundation

**Files:**
- Verify: all files listed above
- Modify only if verification exposes a Phase 1 regression

**Interfaces:**
- Consumes: complete backend and frontend contract foundation.
- Produces: evidence that all first-party tools are covered, current runtime behavior remains intact, and documentation matches the implementation boundary.

- [ ] **Step 1: Run the exhaustive backend contract and MCP tests**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_mcp_tool_contracts.py \
  backend/tests/test_mcp_source_tools.py \
  backend/tests/test_mcp_github_trending_tools.py \
  backend/tests/test_mcp_daily_creation_tools.py \
  backend/tests/test_mcp_creative_asset_tools.py -q
```

Expected: all selected tests PASS with zero failures.

- [ ] **Step 2: Run the focused frontend Tool Registry and Agent regressions**

From `web`:

```bash
pnpm exec vitest run \
  lib/ai/tool-contract.test.ts \
  lib/ai/tool-registry.test.ts \
  lib/ai/agent-capabilities.test.ts \
  lib/ai/agent-tool-policy.test.ts \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/agent-runtime.test.ts \
  lib/ai/pipeline-resolver.test.ts \
  lib/ai/chat-tools.test.ts
```

Expected: all selected tests PASS with zero failures.

- [ ] **Step 3: Run changed-file lint and TypeScript validation**

From `web`:

```bash
pnpm exec eslint \
  lib/ai/tool-contract.ts lib/ai/tool-contract.test.ts \
  lib/ai/tool-registry.ts lib/ai/tool-registry.test.ts \
  lib/ai/global-chat-tools.ts lib/ai/global-chat-tools.test.ts \
  lib/ai/agent-tool-policy.ts lib/ai/agent-tool-policy.test.ts \
  lib/ai/agent-capabilities.ts lib/ai/agent-capabilities.test.ts \
  lib/ai/agent-runtime.ts lib/ai/agent-runtime.test.ts
pnpm exec tsc --noEmit --incremental false
```

Expected: changed-file ESLint passes. TypeScript passes; if unrelated pre-existing errors remain, record their exact paths and confirm none originates in a changed file before proceeding.

- [ ] **Step 4: Inspect the live MCP contract catalog**

From the repository root:

```bash
/home/violet/miniconda3/envs/wems/bin/python - <<'PY'
import asyncio
import sys

sys.path.insert(0, "backend")
import mcp_server
from tool_contracts import EDIORA_TOOL_META_KEY

async def main():
    tools = await mcp_server.mcp.list_tools()
    assert len(tools) == 28
    for tool in tools:
        assert tool.annotations is not None, tool.name
        assert tool.meta and EDIORA_TOOL_META_KEY in tool.meta, tool.name
        print(tool.name, tool.meta[EDIORA_TOOL_META_KEY]["namespace"])

asyncio.run(main())
PY
```

Expected: 28 tool/namespace lines and exit code 0.

- [ ] **Step 5: Check the final diff and commit verification-only fixes if any**

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

If verification required a code correction, stage the changed Phase 1 files shown by `git status --short` using this explicit allowed file set, then commit:

```bash
git add backend/tool_contracts.py backend/mcp_server.py \
  backend/tests/test_mcp_tool_contracts.py \
  web/lib/ai/tool-contract.ts web/lib/ai/tool-contract.test.ts \
  web/lib/ai/tool-registry.ts web/lib/ai/tool-registry.test.ts \
  web/lib/ai/global-chat-tools.ts web/lib/ai/global-chat-tools.test.ts \
  web/lib/ai/agent-tool-policy.ts web/lib/ai/agent-tool-policy.test.ts \
  web/lib/ai/agent-capabilities.ts web/lib/ai/agent-capabilities.test.ts \
  web/lib/ai/agent-runtime.ts web/lib/ai/agent-runtime.test.ts
git commit -m "fix: complete agent tool contract verification"
```

If no correction was required, do not create an empty commit.

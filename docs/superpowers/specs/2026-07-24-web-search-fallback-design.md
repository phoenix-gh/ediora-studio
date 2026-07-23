# Web Search tool with provider fallback

## Goal

Expose a read-only `web_search` Chat tool backed by SearXNG today, while making search providers and their fallback order configurable for later engines.

## Architecture

The Python service owns outbound web-search requests and provider selection. It reads persisted Settings, attempts enabled providers in priority order, and returns one normalized result shape. Chat discovers `web_search` through the existing MCP registry, so no browser-side credential or network configuration is exposed.

## Provider contract

Each adapter implements `search(query, max_results, language) -> list[WebSearchResult]` and raises a provider-scoped failure for unavailable configuration, timeouts, malformed responses, or HTTP errors. The dispatcher tries the next enabled provider on a provider-scoped failure; if all fail, it returns a structured error listing only provider names and safe failure reasons.

`WebSearchResult` contains:

- `title`: result title
- `url`: canonical result URL
- `snippet`: provider result excerpt
- `source`: provider key, initially `searxng`

## First provider: SearXNG

- Request `<base_url>/search` with `q`, `format=json`, `language`, and a capped result count.
- Default to no active provider until a SearXNG Base URL is supplied.
- Use a bounded server-side timeout; no API key is required for standard self-hosted SearXNG.
- Normalize only valid HTTP(S) result URLs, discard malformed result rows, and cap the returned list.

## Settings

Persist a versioned `web_search_providers` JSON list in `AppSetting`. The initial Settings UI manages the SearXNG row and generic provider order:

```json
[
  {"key":"searxng","enabled":true,"base_url":"http://searxng:8080","timeout_seconds":12}
]
```

The Settings response exposes safe provider configuration (key, enabled, base URL, timeout) but no future provider secrets. The update route validates known provider keys and safe HTTP(S) endpoints; adding another engine later means adding one adapter and its Settings fields without changing the Chat tool contract.

## Chat tool

`web_search` is registered from `backend/mcp_server.py`, accepts `query`, optional `max_results` (1–10), and optional `language`. It is read-only and does not require approval. Its tool description directs the model to cite result URLs in its answer and not to claim a search succeeded unless the tool returned results.

## Error behavior

- Missing configuration: actionable message directing the user to Settings → Web 搜索.
- Per-provider failure: dispatcher continues to the next configured provider.
- All providers fail: an error result with safe diagnostics, no fabricated content.
- Empty successful result: return an empty result list and the provider used.

## Verification

- Python unit tests cover SearXNG request construction, normalization, malformed rows, and fallback order.
- Settings route tests cover default, validation, and persistence.
- MCP tool tests cover configured results and unconfigured error output.
- Frontend API/UI tests cover saving and rendering the Web 搜索 Settings section.
- Run focused backend tests, frontend tests, typecheck, and production build.

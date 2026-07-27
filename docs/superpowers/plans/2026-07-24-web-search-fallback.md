# Web Search Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable Chat `web_search` tool that searches SearXNG and can fall back through future providers.

**Architecture:** A backend search module owns provider parsing, SearXNG HTTP requests, normalized results, and priority-ordered fallback. The MCP server exposes it as a read-only tool; Settings stores a JSON provider list and the Next.js Settings page edits the initial SearXNG configuration.

**Tech Stack:** FastAPI, httpx, FastMCP, AppSetting, Next.js/React, Vitest, pytest.

## Global Constraints

- Keep search requests and credentials server-side.
- First supported provider: `searxng`; future provider adapters use the same dispatcher.
- Provider failures fall through; no fabricated results.
- `web_search` is read-only and never requires approval.

---

### Task 1: Provider dispatcher and SearXNG adapter

**Files:**
- Create: `backend/web_search.py`
- Create: `backend/tests/test_web_search.py`
- Modify: `backend/config.py`

**Interfaces:** Produces `WebSearchResult`, `WebSearchProviderError`, `parse_web_search_providers(raw)`, `search_web(query, max_results=5, language='zh-CN')`, and `search_with_providers(query, max_results, language, providers)`.

- [ ] **Step 1: Write failing tests**

```python
@pytest.mark.asyncio
async def test_searxng_normalizes_results(respx_mock):
    respx_mock.get('http://searxng:8080/search').mock(return_value=httpx.Response(200, json={'results': [{'title': 'A', 'url': 'https://example.com', 'content': 'summary'}]}))
    results, provider = await search_with_providers('AI', 5, 'zh-CN', [{'key': 'searxng', 'enabled': True, 'base_url': 'http://searxng:8080', 'timeout_seconds': 12}])
    assert provider == 'searxng'
    assert results == [WebSearchResult(title='A', url='https://example.com', snippet='summary', source='searxng')]
```

- [ ] **Step 2: Verify red**

Run: `conda run -n wems pytest backend/tests/test_web_search.py -q`

Expected: FAIL because `backend.web_search` does not exist.

- [ ] **Step 3: Implement**

```python
async def search_with_providers(query, max_results, language, providers):
    failures = []
    for provider in providers:
        if not provider['enabled']:
            continue
        try:
            return await _search_provider(provider, query, max_results, language), provider['key']
        except WebSearchProviderError as exc:
            failures.append(str(exc))
    raise WebSearchProviderError('web_search', '; '.join(failures) or 'not configured')
```

Implement the SearXNG adapter with `format=json`, bounded timeout, capped results, and HTTP(S)-only URLs.

- [ ] **Step 4: Verify green and commit**

Run: `conda run -n wems pytest backend/tests/test_web_search.py -q`

```bash
git add backend/config.py backend/web_search.py backend/tests/test_web_search.py
git commit -m "feat(search): add provider fallback dispatcher"
```

### Task 2: Settings persistence and validation

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Create: `backend/tests/test_web_search_settings.py`

**Interfaces:** `GET /api/settings` and `PUT /api/settings` consume and produce `web_search_providers: list[{key, enabled, base_url, timeout_seconds}]`.

- [ ] **Step 1: Write failing tests**

```python
async def test_settings_persists_searxng_provider(client):
    response = await client.put('/api/settings', json={'web_search_providers': [{'key': 'searxng', 'enabled': True, 'base_url': 'http://searxng:8080', 'timeout_seconds': 12}]})
    assert response.status_code == 200
    assert response.json()['web_search_providers'][0]['base_url'] == 'http://searxng:8080'

async def test_settings_rejects_non_http_search_url(client):
    response = await client.put('/api/settings', json={'web_search_providers': [{'key': 'searxng', 'enabled': True, 'base_url': 'file:///tmp', 'timeout_seconds': 12}]})
    assert response.status_code == 422
```

- [ ] **Step 2: Verify red**

Run: `conda run -n wems pytest backend/tests/test_web_search_settings.py -q`

Expected: FAIL because Settings has no `web_search_providers` field.

- [ ] **Step 3: Implement**

Add a validated `WebSearchProviderConfig` limited to `searxng`, HTTP(S) URL, enabled flag, timeout 1–30, default `[]`, and JSON persistence in `AppSetting`.

- [ ] **Step 4: Verify green and commit**

Run: `conda run -n wems pytest backend/tests/test_web_search_settings.py -q`

```bash
git add backend/config.py backend/routers/settings.py backend/tests/test_web_search_settings.py
git commit -m "feat(settings): configure web search providers"
```

### Task 3: MCP Chat tool

**Files:**
- Modify: `backend/mcp_server.py`
- Create: `backend/tests/test_mcp_web_search.py`

**Interfaces:** `web_search(query, max_results=5, language='zh-CN')` consumes `search_web` and returns `{provider, results}` or `{error, results: []}`.

- [ ] **Step 1: Write failing test**

```python
@pytest.mark.asyncio
async def test_web_search_tool_returns_normalized_results(monkeypatch):
    monkeypatch.setattr(mcp_server, 'search_web', AsyncMock(return_value=([WebSearchResult('A', 'https://example.com', 'summary', 'searxng')], 'searxng')))
    result = await get_registered_tool('web_search').fn(query='AI', max_results=5, language='zh-CN')
    assert result['results'][0]['url'] == 'https://example.com'
```

- [ ] **Step 2: Verify red**

Run: `conda run -n wems pytest backend/tests/test_mcp_web_search.py -q`

Expected: FAIL because no MCP tool is registered.

- [ ] **Step 3: Implement, verify green, and commit**

Register `@mcp.tool() async def web_search(...)`; clamp result count to 1–10 and convert provider errors to safe error responses.

Run: `conda run -n wems pytest backend/tests/test_mcp_web_search.py backend/tests/test_mcp_search_materials.py -q`

```bash
git add backend/mcp_server.py backend/tests/test_mcp_web_search.py
git commit -m "feat(chat): expose web search tool"
```

### Task 4: Settings UI

**Files:**
- Modify: `wemedia-studio/lib/api/settings.ts`
- Modify: `wemedia-studio/app/settings/SettingsClient.tsx`
- Create: `wemedia-studio/app/settings/sections/WebSearchSection.tsx`
- Create: `wemedia-studio/app/settings/sections/WebSearchSection.test.tsx`

**Interfaces:** The section consumes `AppSettings.web_search_providers`, then saves `{ web_search_providers }` with `updateSettings`.

- [ ] **Step 1: Write failing UI test**

```tsx
it('saves enabled SearXNG settings', async () => {
  render(<WebSearchSection settings={settings} onSaved={onSaved} />)
  await user.type(screen.getByLabelText('SearXNG Base URL'), 'http://searxng:8080')
  await user.click(screen.getByRole('button', { name: '保存 Web 搜索设置' }))
  expect(updateSettings).toHaveBeenCalledWith({ web_search_providers: [{ key: 'searxng', enabled: true, base_url: 'http://searxng:8080', timeout_seconds: 12 }] })
})
```

- [ ] **Step 2: Verify red**

Run: `pnpm exec vitest run app/settings/sections/WebSearchSection.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement**

Add API types, a `web-search` navigation item, and `WebSearchSection` with SearXNG enabled checkbox, Base URL, timeout, fallback explanation, and save button.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm exec vitest run app/settings/sections/WebSearchSection.test.tsx && pnpm exec tsc --noEmit && pnpm build`

```bash
git add wemedia-studio/lib/api/settings.ts wemedia-studio/app/settings/SettingsClient.tsx wemedia-studio/app/settings/sections/WebSearchSection.tsx wemedia-studio/app/settings/sections/WebSearchSection.test.tsx
git commit -m "feat(settings): add web search configuration"
```

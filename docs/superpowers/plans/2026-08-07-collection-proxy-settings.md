# Collection Proxy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one persisted collection proxy setting that immediately and durably configures both `HTTP_PROXY` and `HTTPS_PROXY` for feedgrab/X, Reddit, YouTube, GitHub, and paper collection.

**Architecture:** Keep proxy URL validation, credential-safe display, and process-environment ownership in a focused backend module. The existing settings API persists `collection_proxy_url`; API startup and successful settings updates call the module to synchronize the Python process environment. A dedicated collection-proxy form lives inside the existing Data Collection settings page.

**Tech Stack:** FastAPI, Pydantic v2, SQLAlchemy app settings, Python `os.environ`, React 19, TypeScript, shadcn UI, pytest, Vitest Testing Library.

## Global Constraints

- A single user-entered proxy URL configures both `HTTP_PROXY` and `HTTPS_PROXY`.
- Accepted schemes are exactly `http://`, `https://`, and `socks5://`; non-empty values must include a host.
- Empty configuration disables the app-managed proxy.
- Persist configuration in `app_settings`; do not modify `backend/.env`.
- Apply saved configuration after database initialization and before scheduler registration.
- Saving valid configuration must take effect immediately without a service restart.
- Do not pass this setting to the independent Node creation worker.
- Never expose proxy usernames or passwords in API responses, browser state, toast text, or logs.
- Preserve unrelated changes in the existing mixed worktree and stage only files belonging to each task.

---

## File Structure

- Create `backend/collection_proxy.py`: normalize proxy URLs, produce safe browser output, and own synchronization/restoration of process proxy variables.
- Create `backend/tests/test_collection_proxy.py`: unit coverage for validation, masking, environment synchronization, and restoration.
- Modify `backend/config.py`: register the persisted `collection_proxy_url` default.
- Modify `backend/routers/settings.py`: add settings contract fields, validate writes, return safe state, and apply the proxy after a successful save.
- Create `backend/tests/test_collection_proxy_settings.py`: settings API persistence, redaction, immediate effect, clear behavior, and failed-save behavior.
- Modify `backend/main.py`: restore persisted proxy during startup before scheduler registration.
- Modify `backend/tests/test_job_reconciliation_lifespan.py`: update the existing lifespan fixture for the newly unconditional settings read.
- Create `backend/tests/test_collection_proxy_lifespan.py`: prove startup ordering and scheduler-disabled restoration.
- Modify `wemedia-studio/lib/api/settings.ts`: add browser API types.
- Modify `wemedia-studio/lib/api/settings-test-fixtures.ts`: add proxy defaults.
- Create `wemedia-studio/app/settings/sections/CollectionProxyForm.tsx`: focused proxy editor with save/clear behavior.
- Create `wemedia-studio/app/settings/sections/CollectionProxyForm.test.tsx`: component contract tests.
- Modify `wemedia-studio/app/settings/sections/CollectSection.tsx`: compose RSSHub and collection-proxy sections.

---

### Task 1: Proxy Domain Module

**Files:**
- Create: `backend/collection_proxy.py`
- Create: `backend/tests/test_collection_proxy.py`
- Modify: `backend/config.py`

**Interfaces:**
- Produces: `normalize_collection_proxy_url(value: str) -> str`
- Produces: `collection_proxy_browser_state(value: str) -> tuple[str, bool, str]`, returning `(editable_url, is_set, preview)`
- Produces: `apply_collection_proxy(value: str) -> None`
- Consumes: startup values of `HTTP_PROXY` and `HTTPS_PROXY`, captured once when `backend.collection_proxy` is imported.

- [ ] **Step 1: Write failing validation and browser-state tests**

```python
import importlib

import pytest

import collection_proxy


@pytest.mark.parametrize("value", [
    "http://127.0.0.1:7890",
    "https://proxy.example.com:8443",
    "socks5://127.0.0.1:1080",
])
def test_normalize_collection_proxy_accepts_supported_urls(value):
    assert collection_proxy.normalize_collection_proxy_url(f"  {value}  ") == value


@pytest.mark.parametrize("value", [
    "ftp://proxy.example.com",
    "http:///missing-host",
    "proxy.example.com:7890",
])
def test_normalize_collection_proxy_rejects_invalid_urls(value):
    with pytest.raises(ValueError, match="代理地址"):
        collection_proxy.normalize_collection_proxy_url(value)


def test_browser_state_hides_proxy_credentials():
    editable, configured, preview = collection_proxy.collection_proxy_browser_state(
        "http://alice:secret@proxy.example.com:7890",
    )
    assert editable == ""
    assert configured is True
    assert preview == "http://***@proxy.example.com:7890"
    assert "alice" not in preview
    assert "secret" not in preview


def test_apply_collection_proxy_logs_no_credentials(monkeypatch, caplog):
    module = importlib.reload(collection_proxy)
    module.apply_collection_proxy("http://alice:secret@proxy.example.com:7890")
    observable = caplog.text
    assert "enabled" in observable.lower()
    assert "http" in observable.lower()
    assert "alice" not in observable
    assert "secret" not in observable
```

- [ ] **Step 2: Run tests and verify the module is missing**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy.py -q`

Expected: FAIL during collection with `ModuleNotFoundError: No module named 'collection_proxy'`.

- [ ] **Step 3: Implement normalization and credential-safe browser state**

```python
from urllib.parse import urlsplit

SUPPORTED_PROXY_SCHEMES = {"http", "https", "socks5"}


def normalize_collection_proxy_url(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as error:
        raise ValueError("采集代理地址格式无效") from error
    if parsed.scheme not in SUPPORTED_PROXY_SCHEMES or not parsed.hostname:
        raise ValueError("采集代理地址必须使用 http、https 或 socks5 协议并包含主机")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("采集代理地址不能包含路径、查询参数或片段")
    _ = port
    return normalized


def collection_proxy_browser_state(value: str) -> tuple[str, bool, str]:
    normalized = normalize_collection_proxy_url(value)
    if not normalized:
        return "", False, ""
    parsed = urlsplit(normalized)
    if parsed.username is None and parsed.password is None:
        return normalized, True, normalized
    host = f"[{parsed.hostname}]" if ":" in (parsed.hostname or "") else parsed.hostname
    port = f":{parsed.port}" if parsed.port is not None else ""
    return "", True, f"{parsed.scheme}://***@{host}{port}"
```

- [ ] **Step 4: Write failing environment ownership tests**

```python
import importlib


def test_apply_collection_proxy_sets_both_variables(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://startup-http:8000")
    monkeypatch.setenv("HTTPS_PROXY", "http://startup-https:8443")
    module = importlib.reload(collection_proxy)

    module.apply_collection_proxy("http://127.0.0.1:7890")

    assert module.os.environ["HTTP_PROXY"] == "http://127.0.0.1:7890"
    assert module.os.environ["HTTPS_PROXY"] == "http://127.0.0.1:7890"


def test_clearing_restores_environment_captured_at_import(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://startup-http:8000")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    module = importlib.reload(collection_proxy)
    module.apply_collection_proxy("socks5://127.0.0.1:1080")

    module.apply_collection_proxy("")

    assert module.os.environ["HTTP_PROXY"] == "http://startup-http:8000"
    assert "HTTPS_PROXY" not in module.os.environ
```

- [ ] **Step 5: Implement process environment synchronization and default config**

Add to `backend/collection_proxy.py`:

```python
import os
import logging

_PROXY_ENV_KEYS = ("HTTP_PROXY", "HTTPS_PROXY")
_INITIAL_PROXY_ENV = {key: os.environ.get(key) for key in _PROXY_ENV_KEYS}
logger = logging.getLogger(__name__)


def apply_collection_proxy(value: str) -> None:
    normalized = normalize_collection_proxy_url(value)
    if normalized:
        for key in _PROXY_ENV_KEYS:
            os.environ[key] = normalized
        logger.info("Collection proxy enabled for scheme=%s", urlsplit(normalized).scheme)
        return
    for key, original in _INITIAL_PROXY_ENV.items():
        if original is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = original
    logger.info("Collection proxy disabled; startup environment restored")
```

Add to `backend/config.py` `DEFAULTS`:

```python
"collection_proxy_url": "",
```

- [ ] **Step 6: Run focused tests**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy.py -q`

Expected: all tests PASS.

- [ ] **Step 7: Commit the domain module**

```bash
git add backend/collection_proxy.py backend/config.py backend/tests/test_collection_proxy.py
git commit -m "feat: add collection proxy runtime config"
```

---

### Task 2: Settings API Persistence and Immediate Effect

**Files:**
- Modify: `backend/routers/settings.py`
- Create: `backend/tests/test_collection_proxy_settings.py`

**Interfaces:**
- Consumes: `normalize_collection_proxy_url`, `collection_proxy_browser_state`, and `apply_collection_proxy` from Task 1.
- Produces: `SettingsOut.collection_proxy_url: str`
- Produces: `SettingsOut.collection_proxy_url_set: bool`
- Produces: `SettingsOut.collection_proxy_url_preview: str`
- Produces: `SettingsUpdate.collection_proxy_url: str | None`

- [ ] **Step 1: Write failing API contract tests**

Create a temporary-database `TestClient` fixture following `backend/tests/test_web_search_settings.py`, then add:

```python
def test_collection_proxy_save_persists_and_applies_immediately(client, monkeypatch):
    monkeypatch.delenv("HTTP_PROXY", raising=False)
    monkeypatch.delenv("HTTPS_PROXY", raising=False)

    response = client.put("/api/settings", json={
        "collection_proxy_url": "http://127.0.0.1:7890",
    })

    assert response.status_code == 200, response.text
    assert response.json()["collection_proxy_url"] == "http://127.0.0.1:7890"
    assert response.json()["collection_proxy_url_set"] is True
    assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:7890"
    assert os.environ["HTTPS_PROXY"] == "http://127.0.0.1:7890"
    assert client.get("/api/settings").json()["collection_proxy_url"] == "http://127.0.0.1:7890"


def test_collection_proxy_credentials_are_write_only(client):
    response = client.put("/api/settings", json={
        "collection_proxy_url": "http://alice:secret@proxy.example.com:7890",
    })
    body = response.json()
    assert body["collection_proxy_url"] == ""
    assert body["collection_proxy_url_set"] is True
    assert body["collection_proxy_url_preview"] == "http://***@proxy.example.com:7890"
    assert "alice" not in response.text
    assert "secret" not in response.text


def test_collection_proxy_rejects_invalid_url_without_changing_environment(client, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://current:7890")
    monkeypatch.setenv("HTTPS_PROXY", "http://current:7890")
    response = client.put("/api/settings", json={"collection_proxy_url": "file:///tmp/proxy"})
    assert response.status_code == 422
    assert os.environ["HTTP_PROXY"] == "http://current:7890"
    assert os.environ["HTTPS_PROXY"] == "http://current:7890"


def test_collection_proxy_database_failure_does_not_change_environment(client, monkeypatch):
    import routers.settings as settings_router
    monkeypatch.setenv("HTTP_PROXY", "http://current:7890")
    monkeypatch.setenv("HTTPS_PROXY", "http://current:7890")

    async def fail_set_config(_updates):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(settings_router, "set_config", fail_set_config)
    with pytest.raises(RuntimeError, match="database unavailable"):
        client.put("/api/settings", json={"collection_proxy_url": "http://next:7890"})
    assert os.environ["HTTP_PROXY"] == "http://current:7890"
    assert os.environ["HTTPS_PROXY"] == "http://current:7890"
```

- [ ] **Step 2: Run contract tests and verify missing schema fields**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy_settings.py -q`

Expected: FAIL because `collection_proxy_url` is not accepted or returned.

- [ ] **Step 3: Extend settings schemas and safe output**

In `backend/routers/settings.py`, import the Task 1 helpers and add:

```python
class SettingsOut(BaseModel):
    collection_proxy_url: str
    collection_proxy_url_set: bool
    collection_proxy_url_preview: str


class SettingsUpdate(BaseModel):
    collection_proxy_url: Optional[str] = None

    @field_validator("collection_proxy_url")
    @classmethod
    def validate_collection_proxy_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return normalize_collection_proxy_url(value)
```

At the start of `_build_out`, compute:

```python
proxy_url, proxy_set, proxy_preview = collection_proxy_browser_state(
    cfg.get("collection_proxy_url", ""),
)
```

Pass the values as the following named arguments in the existing `SettingsOut` constructor:

```python
collection_proxy_url=proxy_url,
collection_proxy_url_set=proxy_set,
collection_proxy_url_preview=proxy_preview,
```

- [ ] **Step 4: Persist then apply the proxy**

In `update_settings`, add the normalized update before `set_config`:

```python
if body.collection_proxy_url is not None:
    updates["collection_proxy_url"] = body.collection_proxy_url
```

Immediately after successful `await set_config(updates)`:

```python
if "collection_proxy_url" in updates:
    apply_collection_proxy(updates["collection_proxy_url"])
```

Do not put `apply_collection_proxy` before or inside a `finally` block; failed persistence must retain the currently effective environment.

- [ ] **Step 5: Add clear and malformed-stored-value coverage**

```python
def test_collection_proxy_clear_restores_startup_environment(client):
    client.put("/api/settings", json={"collection_proxy_url": "http://127.0.0.1:7890"})
    response = client.put("/api/settings", json={"collection_proxy_url": ""})
    assert response.status_code == 200
    assert response.json()["collection_proxy_url_set"] is False


def test_settings_get_survives_malformed_legacy_proxy_value(client, monkeypatch):
    import routers.settings as settings_router

    async def malformed_config():
        return {"collection_proxy_url": "not a url"}

    monkeypatch.setattr(settings_router, "get_config", malformed_config)
    response = client.get("/api/settings")
    assert response.status_code == 200
    assert response.json()["collection_proxy_url_set"] is False
```

Implement `_build_out` defensively: catch `ValueError`, log only `Ignoring malformed collection proxy configuration`, and return blank proxy state without including the stored value in logs.

- [ ] **Step 6: Run focused settings tests**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy.py backend/tests/test_collection_proxy_settings.py -q`

Expected: all tests PASS.

- [ ] **Step 7: Commit the API integration**

```bash
git add backend/routers/settings.py backend/tests/test_collection_proxy_settings.py
git commit -m "feat: expose collection proxy settings"
```

---

### Task 3: Startup Restoration Before Scheduled Collection

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/tests/test_job_reconciliation_lifespan.py`
- Create: `backend/tests/test_collection_proxy_lifespan.py`

**Interfaces:**
- Consumes: `apply_collection_proxy(value: str) -> None` from Task 1.
- Consumes: `get_config() -> dict[str, str]` from the existing config store.
- Produces: lifespan ordering `init_db → get_config → apply_collection_proxy → register_jobs → scheduler.start`.

- [ ] **Step 1: Write a failing lifespan ordering test**

Use the same lightweight monkeypatch strategy as `test_job_reconciliation_lifespan.py`. Record calls from `init_db`, `get_config`, `apply_collection_proxy`, `register_jobs`, and `scheduler.start`, then assert:

```python
assert calls.index("init-db") < calls.index("get-config")
assert calls.index("get-config") < calls.index("proxy:http://127.0.0.1:7890")
assert calls.index("proxy:http://127.0.0.1:7890") < calls.index("register-jobs")
assert calls.index("register-jobs") < calls.index("scheduler-start")
```

Also add a scheduler-disabled test asserting `apply_collection_proxy` is still called while `register_jobs` and `scheduler.start` are not.

- [ ] **Step 2: Run lifespan tests and verify startup does not apply proxy**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy_lifespan.py backend/tests/test_job_reconciliation_lifespan.py -q`

Expected: new ordering tests FAIL because startup does not call `apply_collection_proxy`; the existing scheduler-disabled fixture may also fail once `get_config` becomes unconditional until Step 3 updates it.

- [ ] **Step 3: Apply configuration once before scheduler branching**

In `backend/main.py`, import `apply_collection_proxy`. After `init_db()` and before creating scheduled work, load configuration once:

```python
from config import get_config

cfg = await get_config()
apply_collection_proxy(cfg.get("collection_proxy_url", ""))
```

Reuse the same `cfg` in `job_registry.register_jobs(scheduler, cfg)`; remove the nested import and second `get_config()` call from the scheduler-enabled branch.

Update `test_job_reconciliation_lifespan.py` so its fake `get_config` returns `{}` instead of `[]`, and monkeypatch `main.apply_collection_proxy` to a no-op when that test is not checking proxy behavior.

- [ ] **Step 4: Run lifespan and proxy tests**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_collection_proxy.py backend/tests/test_collection_proxy_settings.py backend/tests/test_collection_proxy_lifespan.py backend/tests/test_job_reconciliation_lifespan.py -q`

Expected: all tests PASS and ordering assertions prove the first scheduler run sees the saved proxy.

- [ ] **Step 5: Commit startup restoration**

```bash
git add backend/main.py backend/tests/test_collection_proxy_lifespan.py backend/tests/test_job_reconciliation_lifespan.py
git commit -m "feat: restore collection proxy at startup"
```

---

### Task 4: Data Collection Settings UI

**Files:**
- Modify: `wemedia-studio/lib/api/settings.ts`
- Modify: `wemedia-studio/lib/api/settings-test-fixtures.ts`
- Create: `wemedia-studio/app/settings/sections/CollectionProxyForm.tsx`
- Create: `wemedia-studio/app/settings/sections/CollectionProxyForm.test.tsx`
- Modify: `wemedia-studio/app/settings/sections/CollectSection.tsx`

**Interfaces:**
- Consumes: `AppSettings.collection_proxy_url`, `collection_proxy_url_set`, and `collection_proxy_url_preview` from Task 2.
- Consumes: `updateSettings({collection_proxy_url: string}) -> Promise<AppSettings>`.
- Produces: `CollectionProxyForm({settings, onSaved})` rendered under Data Collection settings.

- [ ] **Step 1: Add browser settings types and fixture defaults**

Add to `AppSettings`:

```typescript
collection_proxy_url: string
collection_proxy_url_set: boolean
collection_proxy_url_preview: string
```

Add to `SettingsUpdate`:

```typescript
collection_proxy_url?: string
```

Add to `makeSettings` defaults:

```typescript
collection_proxy_url: '',
collection_proxy_url_set: false,
collection_proxy_url_preview: '',
```

- [ ] **Step 2: Write failing form behavior tests**

```tsx
it('saves one URL for both collection proxy variables', async () => {
  const saved = makeSettings({
    collection_proxy_url: 'http://127.0.0.1:7890',
    collection_proxy_url_set: true,
    collection_proxy_url_preview: 'http://127.0.0.1:7890',
  })
  vi.mocked(updateSettings).mockResolvedValue(saved)
  render(<CollectionProxyForm settings={makeSettings()} onSaved={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('代理地址'), {
    target: { value: 'http://127.0.0.1:7890' },
  })
  fireEvent.click(screen.getByRole('button', { name: '保存代理' }))
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
    collection_proxy_url: 'http://127.0.0.1:7890',
  }))
})

it('does not overwrite a credential proxy when the masked input is blank', () => {
  render(<CollectionProxyForm settings={makeSettings({
    collection_proxy_url: '',
    collection_proxy_url_set: true,
    collection_proxy_url_preview: 'http://***@proxy.example.com:7890',
  })} onSaved={vi.fn()} />)
  expect(screen.getByText('http://***@proxy.example.com:7890')).toBeVisible()
  expect(screen.getByRole('button', { name: '保存代理' })).toBeDisabled()
})

it('clears the proxy explicitly', async () => {
  vi.mocked(updateSettings).mockResolvedValue(makeSettings())
  render(<CollectionProxyForm settings={makeSettings({
    collection_proxy_url: 'http://127.0.0.1:7890',
    collection_proxy_url_set: true,
    collection_proxy_url_preview: 'http://127.0.0.1:7890',
  })} onSaved={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '清除代理' }))
  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
    collection_proxy_url: '',
  }))
})
```

Also assert the form includes `X / feedgrab`、`Reddit`、`YouTube`、`GitHub`、`论文` and explains that both environment variables receive the same URL.

- [ ] **Step 3: Run the form test and verify the component is missing**

Run: `pnpm test -- app/settings/sections/CollectionProxyForm.test.tsx`

Working directory: `wemedia-studio`

Expected: FAIL because `CollectionProxyForm` does not exist.

- [ ] **Step 4: Implement the focused proxy form**

The component must:

```tsx
export function CollectionProxyForm({ settings, onSaved }: Props) {
  const [proxyUrl, setProxyUrl] = useState(settings?.collection_proxy_url ?? '')
  const [saving, setSaving] = useState(false)

  async function save(value: string) {
    setSaving(true)
    try {
      const updated = await updateSettings({ collection_proxy_url: value })
      setProxyUrl(updated.collection_proxy_url)
      onSaved(updated)
      toast.success(value ? '采集代理已保存并立即生效' : '采集代理已清除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存采集代理失败')
    } finally {
      setSaving(false)
    }
  }
```

Render it as a `FormSection` titled `采集网络代理`, with:

- `Input` label `代理地址`, placeholder `http://127.0.0.1:7890`, and `font-mono`.
- status text based on `collection_proxy_url_set` and safe `collection_proxy_url_preview`.
- `保存代理` disabled while saving or when a credential-bearing saved proxy is represented by a blank input.
- `清除代理` shown only when configured and calling `save('')`.
- copy explaining one URL sets both variables and listing all five source families.

- [ ] **Step 5: Compose it into Data Collection settings**

Change `CollectSection` from one `FormSection` root to:

```tsx
return (
  <div className="flex flex-col gap-6">
    <FormSection
      title="RSSHub"
      description="将 X / 知乎 / 微博等平台转换为 RSS 源，可使用本地部署或公共实例地址。"
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="rsshub-base">RSSHub 地址</FieldLabel>
          <Input
            id="rsshub-base"
            value={rsshub}
            onChange={event => setRsshub(event.target.value)}
            placeholder="http://127.0.0.1:1200"
            className="font-mono"
          />
          <FieldDescription>地址会按原样保存，便于使用容器内或本机地址。</FieldDescription>
        </Field>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Save data-icon="inline-start" />}
          保存
        </Button>
      </FieldGroup>
    </FormSection>
    <CollectionProxyForm settings={settings} onSaved={onSaved} />
  </div>
)
```

- [ ] **Step 6: Run UI tests and type checks**

Run: `pnpm test -- app/settings/sections/CollectionProxyForm.test.tsx app/settings/sections/XSection.test.tsx lib/api/settings-telegram.test.ts`

Run: `pnpm exec tsc --noEmit`

Working directory: `wemedia-studio`

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the settings UI**

```bash
git add wemedia-studio/lib/api/settings.ts wemedia-studio/lib/api/settings-test-fixtures.ts wemedia-studio/app/settings/sections/CollectionProxyForm.tsx wemedia-studio/app/settings/sections/CollectionProxyForm.test.tsx wemedia-studio/app/settings/sections/CollectSection.tsx
git commit -m "feat: add collection proxy settings UI"
```

---

### Task 5: Integrated Verification

**Files:**
- Verify only; no production files added.

**Interfaces:**
- Consumes the complete backend and frontend feature from Tasks 1–4.
- Produces evidence that persistence, startup restoration, immediate effect, redaction, and UI behavior work together.

- [ ] **Step 1: Run the complete focused backend suite**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_collection_proxy.py \
  backend/tests/test_collection_proxy_settings.py \
  backend/tests/test_collection_proxy_lifespan.py \
  backend/tests/test_job_reconciliation_lifespan.py \
  backend/tests/test_feedgrab_client.py \
  backend/tests/test_x_router.py -q
```

Expected: all tests PASS. If an unrelated pre-existing fixture or local-binding failure occurs, report it exactly and do not label that test as passing.

- [ ] **Step 2: Run the complete focused frontend suite**

Working directory: `wemedia-studio`

Run:

```bash
pnpm test -- \
  app/settings/sections/CollectionProxyForm.test.tsx \
  app/settings/sections/XSection.test.tsx \
  app/settings/SettingsClient.test.tsx \
  lib/api/settings-telegram.test.ts
```

Run: `pnpm exec tsc --noEmit`

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 3: Verify the diff is scoped and safe**

Run:

```bash
git diff --check
git status --short
git diff -- backend/collection_proxy.py backend/config.py backend/main.py backend/routers/settings.py backend/tests/test_collection_proxy.py backend/tests/test_collection_proxy_settings.py backend/tests/test_collection_proxy_lifespan.py backend/tests/test_job_reconciliation_lifespan.py wemedia-studio/lib/api/settings.ts wemedia-studio/lib/api/settings-test-fixtures.ts wemedia-studio/app/settings/sections/CollectionProxyForm.tsx wemedia-studio/app/settings/sections/CollectionProxyForm.test.tsx wemedia-studio/app/settings/sections/CollectSection.tsx
```

Expected: no whitespace errors; only the planned feature files contain newly introduced proxy changes. Existing unrelated worktree changes remain untouched.

- [ ] **Step 4: Commit any verification-only corrections**

If verification required corrections, stage only the files changed for those corrections and commit:

```bash
git commit -m "fix: harden collection proxy settings"
```

If no corrections were needed, do not create an empty commit.

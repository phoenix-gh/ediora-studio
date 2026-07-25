# Telegram Bot Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the existing single Telegram Bot configuration with safe saved-credential testing, explicit clearing, and persisted last-test status.

**Architecture:** The existing write-only `telegram_bot_token` and visible `telegram_chat_id` remain in `app_settings`. Dedicated settings endpoints call the production Telegram adapter using only saved server-side values, persist a bounded test status, and return the normal secret-safe settings shape; a focused React card owns Telegram form dirtiness and prevents testing unsaved values.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy-backed `app_settings`, httpx, pytest, Next.js 16.2, React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Execute this plan after the X credential-pool plan; it consumes the shared `backend/log_redaction.py` installed there.
- Telegram remains one Bot Token plus one Chat ID; no multi-bot or multi-destination routing.
- Bot Token is write-only and only the fixed last-four preview is returned.
- A blank Bot Token on `PUT /api/settings` preserves the saved Token; explicit clearing uses only the DELETE endpoint.
- Changing the saved Bot Token or Chat ID resets previous Telegram test metadata.
- The test endpoint accepts no Token or Chat ID body and uses only saved server-side configuration.
- Test sends one fixed Chinese HTML-safe message with an Asia/Shanghai timestamp.
- A failed test persists a cleaned error but never clears or replaces the saved Token or Chat ID.
- Clear requires frontend confirmation and removes Token, Chat ID, and all Telegram test metadata.
- Telegram tests do not create or mutate X response decisions, job steps, notification tiers, or message IDs.
- No automatic X publishing behavior is added.

---

## File Structure

### Backend

- Modify `backend/config.py`: add default Telegram test metadata keys.
- Modify `backend/routers/settings.py`: expose test metadata and add test/clear endpoints.
- Modify `backend/telegram_notifier.py`: render the fixed test message.
- Modify `backend/tests/test_web_search_settings.py`: saved-only test, clear, persistence, and no-secret tests.
- Modify `backend/tests/test_telegram_notifier.py`: deterministic test-message rendering.

### Frontend

- Modify `wemedia-studio/lib/api/settings.ts`: add safe metadata and test/clear functions.
- Create `wemedia-studio/lib/api/settings-test-fixtures.ts`: complete `AppSettings` factory shared only by settings tests.
- Create `wemedia-studio/lib/api/settings-telegram.test.ts`: request and response contracts.
- Create `wemedia-studio/app/settings/sections/TelegramSettingsCard.tsx`: form, save/test/clear, dirty-state protection.
- Create `wemedia-studio/app/settings/sections/TelegramSettingsCard.test.tsx`: rendered actions and safety behavior.
- Modify `wemedia-studio/app/settings/sections/XSection.tsx`: compose the Telegram card and remove inline Telegram state.

### Documentation

- Modify `README.md`: document saved-only testing and clear behavior.

---

### Task 1: Telegram Test Message and Safe Backend Endpoints

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `backend/telegram_notifier.py`
- Modify: `backend/tests/test_web_search_settings.py`
- Modify: `backend/tests/test_telegram_notifier.py`

**Interfaces:**
- Consumes: `telegram_notifier.send_html_messages(token, chat_id, messages)`.
- Produces:
  - `render_test_message(tested_at: datetime) -> str`.
  - `POST /api/settings/telegram/test`.
  - `DELETE /api/settings/telegram`.
  - New safe settings fields:
    - `telegram_test_status: "" | "success" | "failed"`.
    - `telegram_last_tested_at: str`.
    - `telegram_last_test_error: str`.

- [ ] **Step 1: Write the failing deterministic render test**

```python
def test_render_test_message_is_fixed_chinese_and_shanghai_time():
    tested_at = datetime(2026, 7, 25, 13, 6, 7, tzinfo=timezone.utc)
    message = render_test_message(tested_at)
    assert "WeMedia Studio Telegram 连接测试成功" in message
    assert "2026-07-25 21:06:07" in message
    assert "<script" not in message
```

- [ ] **Step 2: Run the notifier test and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_telegram_notifier.py::test_render_test_message_is_fixed_chinese_and_shanghai_time -q
```

Expected: import failure because `render_test_message` does not exist.

- [ ] **Step 3: Implement the fixed test renderer**

```python
def render_test_message(tested_at: datetime) -> str:
    shanghai = tested_at.astimezone(ZoneInfo("Asia/Shanghai"))
    stamp = shanghai.strftime("%Y-%m-%d %H:%M:%S")
    return (
        "✅ <b>WeMedia Studio Telegram 连接测试成功</b>\n"
        f"测试时间：{stamp}（Asia/Shanghai）"
    )
```

- [ ] **Step 4: Write failing saved-only endpoint tests**

```python
def test_telegram_test_uses_saved_credentials_and_persists_success(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })
    captured = {}

    async def fake_send(token, chat_id, messages, **_kwargs):
        captured.update(token=token, chat_id=chat_id, messages=messages)
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    response = client.post("/api/settings/telegram/test")

    assert response.status_code == 200, response.text
    assert captured["token"] == "saved-token"
    assert captured["chat_id"] == "-100123"
    body = response.json()
    assert body["telegram_test_status"] == "success"
    assert body["telegram_last_tested_at"]
    assert body["telegram_last_test_error"] == ""
    assert "telegram_bot_token" not in body


def test_telegram_test_failure_keeps_configuration(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fail_send(*_args, **_kwargs):
        raise TelegramSendError("chat not found", retryable=False)

    monkeypatch.setattr("telegram_notifier.send_html_messages", fail_send)
    response = client.post("/api/settings/telegram/test")
    assert response.status_code == 503

    settings = client.get("/api/settings").json()
    assert settings["telegram_bot_token_set"] is True
    assert settings["telegram_chat_id"] == "-100123"
    assert settings["telegram_test_status"] == "failed"
    assert settings["telegram_last_test_error"] == "chat not found"


def test_telegram_save_preserves_blank_token_and_resets_old_test_status(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fake_send(*_args, **_kwargs):
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    assert client.post("/api/settings/telegram/test").status_code == 200

    client.put("/api/settings", json={
        "telegram_bot_token": "",
        "telegram_chat_id": "-100999",
    })
    body = client.get("/api/settings").json()
    assert body["telegram_bot_token_set"] is True
    assert body["telegram_bot_token_preview"] == "…oken"
    assert body["telegram_chat_id"] == "-100999"
    assert body["telegram_test_status"] == ""
    assert body["telegram_last_tested_at"] == ""
    assert body["telegram_last_test_error"] == ""
```

- [ ] **Step 5: Run endpoint tests and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_web_search_settings.py -q
```

Expected: 404 for `/api/settings/telegram/test` or missing output fields.

- [ ] **Step 6: Add defaults, safe output fields, and test endpoint**

Add defaults:

```python
"telegram_test_status": "",
"telegram_last_tested_at": "",
"telegram_last_test_error": "",
```

Import `timezone` alongside `datetime` in `routers/settings.py`, and import `ZoneInfo` in `telegram_notifier.py`. Add fields to `SettingsOut` and `_build_out()` without adding `telegram_bot_token`.

In `update_settings()`, omit a blank `telegram_bot_token` instead of clearing the saved value. Compare the submitted nonblank Token and submitted Chat ID with the saved configuration; when either changes, include empty values for all three test metadata keys in the same `set_config()` call.

Endpoint behavior:

```python
@router.post("/telegram/test", response_model=SettingsOut)
async def test_telegram():
    cfg = await get_config()
    tested_at = datetime.now(timezone.utc)
    try:
        await telegram_notifier.send_html_messages(
            cfg.get("telegram_bot_token", ""),
            cfg.get("telegram_chat_id", ""),
            [telegram_notifier.render_test_message(tested_at)],
        )
    except telegram_notifier.TelegramSendError as exc:
        await set_config({
            "telegram_test_status": "failed",
            "telegram_last_tested_at": tested_at.isoformat(),
            "telegram_last_test_error": redact_secret_text(str(exc))[:500],
        })
        raise HTTPException(503, redact_secret_text(str(exc))[:500]) from exc
    await set_config({
        "telegram_test_status": "success",
        "telegram_last_tested_at": tested_at.isoformat(),
        "telegram_last_test_error": "",
    })
    return _build_out(await get_config())
```

- [ ] **Step 7: Write and implement clear behavior**

RED test:

```python
def test_clear_telegram_removes_credentials_and_test_metadata(client, monkeypatch):
    client.put("/api/settings", json={
        "telegram_bot_token": "saved-token",
        "telegram_chat_id": "-100123",
    })

    async def fake_send(*_args, **_kwargs):
        return [91]

    monkeypatch.setattr("telegram_notifier.send_html_messages", fake_send)
    tested = client.post("/api/settings/telegram/test")
    assert tested.status_code == 200

    response = client.delete("/api/settings/telegram")
    assert response.status_code == 200
    body = response.json()
    assert body["telegram_bot_token_set"] is False
    assert body["telegram_bot_token_preview"] == ""
    assert body["telegram_chat_id"] == ""
    assert body["telegram_test_status"] == ""
    assert body["telegram_last_tested_at"] == ""
    assert body["telegram_last_test_error"] == ""
```

Implementation:

```python
@router.delete("/telegram", response_model=SettingsOut)
async def clear_telegram():
    await set_config({
        "telegram_bot_token": "",
        "telegram_chat_id": "",
        "telegram_test_status": "",
        "telegram_last_tested_at": "",
        "telegram_last_test_error": "",
    })
    return _build_out(await get_config())
```

- [ ] **Step 8: Run Task 1 tests and commit**

Run:

```bash
conda run -n wems pytest \
  backend/tests/test_web_search_settings.py \
  backend/tests/test_telegram_notifier.py \
  backend/tests/test_x_responses_router.py \
  backend/tests/test_x_response_end_to_end.py -q
git diff --check
```

Expected: all settings, notifier, notification, and controlled end-to-end tests pass.

Commit:

```bash
git add \
  backend/config.py backend/routers/settings.py backend/telegram_notifier.py \
  backend/tests/test_web_search_settings.py backend/tests/test_telegram_notifier.py
git commit -m "feat(telegram): add saved-configuration self-test"
```

---

### Task 2: Telegram Frontend API Contract

**Files:**
- Modify: `wemedia-studio/lib/api/settings.ts`
- Create: `wemedia-studio/lib/api/settings-test-fixtures.ts`
- Create: `wemedia-studio/lib/api/settings-telegram.test.ts`

**Interfaces:**
- Consumes: Task 1 endpoints.
- Produces:
  - `testTelegramSettings() -> Promise<AppSettings>`.
  - `clearTelegramSettings() -> Promise<AppSettings>`.
  - Safe `AppSettings` metadata fields.

- [ ] **Step 1: Write failing API tests**

```typescript
it('tests and clears only the saved Telegram configuration', async () => {
  const settingsFixture = makeSettings({
    telegram_bot_token_set: true,
    telegram_bot_token_preview: '…cret',
    telegram_chat_id: '-100123',
  })
  const fetchMock = vi.fn().mockResolvedValue(new Response(
    JSON.stringify(settingsFixture),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)

  await testTelegramSettings()
  await clearTelegramSettings()

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'http://localhost:8000/api/settings/telegram/test',
    expect.objectContaining({ method: 'POST' }),
  )
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    'http://localhost:8000/api/settings/telegram',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test lib/api/settings-telegram.test.ts
```

Expected: import failure because the new functions do not exist.

- [ ] **Step 3: Extend safe settings types and add client functions**

```typescript
export interface AppSettings {
  // existing fields stay unchanged
  telegram_test_status: '' | 'success' | 'failed'
  telegram_last_tested_at: string
  telegram_last_test_error: string
}

export async function testTelegramSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings/telegram/test', { method: 'POST' })
}

export async function clearTelegramSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>('/settings/telegram', { method: 'DELETE' })
}
```

- [ ] **Step 4: Add a complete settings test fixture factory**

Create `settings-test-fixtures.ts`:

```typescript
import type { AppSettings } from './settings'

export function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    llm_provider: 'openai',
    llm_model: 'gpt-4o-mini',
    llm_base_url: '',
    llm_effective_base_url: 'https://api.openai.com/v1',
    llm_api_key_set: false,
    llm_api_key_preview: '',
    image_model: 'gpt-image-1',
    image_base_url: '',
    image_api_key_set: false,
    image_api_key_preview: '',
    rsshub_base: 'http://127.0.0.1:1200',
    github_token_set: false,
    github_token_preview: '',
    github_interval_minutes: 1,
    github_trending_interval_hours: 6,
    camofox_url: 'http://localhost:9377',
    camofox_api_key_set: false,
    camofox_user_id: 'wemedia_x',
    camofox_novnc_url: 'http://localhost:6080/vnc.html',
    x_collect_interval_minutes: 15,
    x_notify_enabled: true,
    telegram_bot_token_set: false,
    telegram_bot_token_preview: '',
    telegram_chat_id: '',
    telegram_test_status: '',
    telegram_last_tested_at: '',
    telegram_last_test_error: '',
    x_response_account_id: '',
    arxiv_categories: 'cs.AI,cs.CL,cs.CV,cs.LG',
    arxiv_collect_interval_hours: 6,
    ref_collect_interval_minutes: 15,
    ref_classify_interval_minutes: 60,
    clean_batch_size: 20,
    wechat_tunnel_enabled: false,
    wechat_tunnel_ssh_host: '',
    wechat_tunnel_ssh_port: 22,
    wechat_tunnel_ssh_user: '',
    wechat_tunnel_ssh_key_path: '',
    wechat_tunnel_local_host: '127.0.0.1',
    wechat_tunnel_local_port: 18443,
    wechat_tunnel_remote_host: 'api.weixin.qq.com',
    wechat_tunnel_remote_port: 443,
    wechat_tunnel_extra_args: '',
    blog_api_base: 'https://mkflow.dev',
    blog_api_token_set: false,
    blog_api_token_preview: '',
    web_search_providers: [],
    web_fetch_providers: [],
    providers: [],
    ...overrides,
  }
}
```

Import `makeSettings` in both Telegram frontend test files. This factory must compile with `satisfies AppSettings` semantics: when `AppSettings` changes, TypeScript forces the fixture to change too.

- [ ] **Step 5: Run Task 2 tests and commit**

Run:

```bash
pnpm test lib/api/settings-telegram.test.ts
pnpm exec tsc --noEmit
```

Expected: API tests and TypeScript pass.

Commit:

```bash
git add \
  wemedia-studio/lib/api/settings.ts \
  wemedia-studio/lib/api/settings-test-fixtures.ts \
  wemedia-studio/lib/api/settings-telegram.test.ts
git commit -m "feat(telegram): add settings client actions"
```

---

### Task 3: Telegram Settings Card and Full Verification

**Files:**
- Create: `wemedia-studio/app/settings/sections/TelegramSettingsCard.tsx`
- Create: `wemedia-studio/app/settings/sections/TelegramSettingsCard.test.tsx`
- Modify: `wemedia-studio/app/settings/sections/XSection.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `AppSettings`, `updateSettings`, `testTelegramSettings`, and `clearTelegramSettings`.
- Produces:
  - `<TelegramSettingsCard settings={settings} onSaved={onSaved} />`.

- [ ] **Step 1: Write failing rendered interaction tests**

```typescript
// @vitest-environment jsdom
const emptySettings = makeSettings()
const configuredSettings = makeSettings({
  telegram_bot_token_set: true,
  telegram_bot_token_preview: '…cret',
  telegram_chat_id: '-100123',
  telegram_test_status: 'success',
  telegram_last_tested_at: '2026-07-25T13:06:07Z',
  telegram_last_test_error: '',
})


it('saves a write-only token and clears the input after success', async () => {
  vi.mocked(updateSettings).mockResolvedValue(configuredSettings)
  const onSaved = vi.fn()
  const user = userEvent.setup()
  render(<TelegramSettingsCard settings={emptySettings} onSaved={onSaved} />)

  await user.type(screen.getByLabelText('Telegram Bot Token'), '123:secret')
  await user.type(screen.getByLabelText('Telegram Chat ID'), '-100123')
  await user.click(screen.getByRole('button', { name: '保存 Telegram 配置' }))

  expect(updateSettings).toHaveBeenCalledWith({
    telegram_bot_token: '123:secret',
    telegram_chat_id: '-100123',
  })
  expect(screen.getByLabelText('Telegram Bot Token')).toHaveValue('')
  expect(onSaved).toHaveBeenCalledWith(configuredSettings)
})


it('does not test unsaved form changes', async () => {
  const user = userEvent.setup()
  render(<TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />)
  await user.clear(screen.getByLabelText('Telegram Chat ID'))
  await user.type(screen.getByLabelText('Telegram Chat ID'), '-100999')

  expect(screen.getByRole('button', { name: '发送测试消息' })).toBeDisabled()
  expect(screen.getByText('请先保存当前修改')).toBeInTheDocument()
  expect(testTelegramSettings).not.toHaveBeenCalled()
})


it('confirms and clears Telegram configuration', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(clearTelegramSettings).mockResolvedValue(emptySettings)
  const user = userEvent.setup()
  render(<TelegramSettingsCard settings={configuredSettings} onSaved={vi.fn()} />)

  await user.click(screen.getByRole('button', { name: '清除 Telegram 配置' }))
  expect(clearTelegramSettings).toHaveBeenCalledOnce()
})
```

Add a separate test for test-success/test-failure loading and rendered metadata.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test app/settings/sections/TelegramSettingsCard.test.tsx
```

Expected: import failure because the card does not exist.

- [ ] **Step 3: Implement the focused card**

The card owns:

```typescript
const [token, setToken] = useState('')
const [chatId, setChatId] = useState(settings?.telegram_chat_id ?? '')
const [saving, setSaving] = useState(false)
const [testing, setTesting] = useState(false)
const [clearing, setClearing] = useState(false)

const dirty =
  token.trim().length > 0
  || chatId.trim() !== (settings?.telegram_chat_id ?? '')
```

Rules:

- save includes `telegram_bot_token` only when nonblank;
- successful save clears the local token;
- test is disabled when dirty or when saved Token/Chat ID is missing;
- clear uses `confirm('清除 Telegram Bot Token、Chat ID 和测试记录？')`;
- success/failure metadata comes from `settings`, not local guesses;
- errors use `toast.error((error as Error).message || '操作失败')`;
- no raw saved Token is ever placed in component props or state.

- [ ] **Step 4: Integrate into X settings**

Remove inline Telegram token/chat state and JSX from `XSection.tsx`. Render:

```tsx
<XCredentialAccountsCard />
<TelegramSettingsCard settings={settings} onSaved={onSaved} />
```

Keep the X interval, realtime-response switch, and publish-account profile save path independent. Saving X collection settings must no longer resend Telegram fields.

- [ ] **Step 5: Update Telegram operator documentation**

Document:

- BotFather creation and Chat ID discovery;
- save before testing;
- fixed test message behavior;
- Token only-write preview;
- clear removes configuration but not historical response records;
- real delivery remains a manual acceptance step requiring configured credentials.

- [ ] **Step 6: Run frontend and repository verification**

Run:

```bash
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
pnpm build
cd ..
conda run -n wems pytest backend/tests -q
conda run -n wems python -m compileall -q backend
docker compose config -q
git diff --check
git status --short
```

Expected: full frontend/backend suites, typecheck, build, Python compilation, and Compose validation pass.

Run a rendered settings-page check using Playwright from the `wems` environment:

Create `/tmp/wms-telegram-settings-ui-check.py` with:

```python
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


with urlopen("http://localhost:8000/api/settings") as response:
    settings = json.load(response)
settings.update({
    "telegram_bot_token_set": True,
    "telegram_bot_token_preview": "…cret",
    "telegram_chat_id": "-100123",
    "telegram_test_status": "success",
    "telegram_last_tested_at": "2026-07-25T13:06:07Z",
    "telegram_last_test_error": "",
})

errors: list[str] = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})

    def route_settings(route):
        request = route.request
        if request.method == "GET" and request.url.rstrip("/").endswith("/api/settings"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps(settings),
            )
        else:
            route.continue_()

    page.route("**/api/settings", route_settings)
    page.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://localhost:3000/settings", wait_until="networkidle")
    page.get_by_role("tab", name="X / Twitter").click()
    page.get_by_text("…cret", exact=True).wait_for()
    chat_id = page.get_by_label("Telegram Chat ID")
    chat_id.fill("-100999")
    assert page.get_by_role("button", name="发送测试消息").is_disabled()
    page.screenshot(path="/tmp/wms-telegram-settings.png", full_page=True)
    browser.close()

framework_errors = [
    message for message in errors
    if "hydration" in message.lower()
    or "uncaught" in message.lower()
    or "next" in message.lower()
]
assert not framework_errors, framework_errors
assert Path("/tmp/wms-telegram-settings.png").is_file()
```

Create this temporary file with `apply_patch`, then run:

```bash
conda run --no-capture-output -n wems python /tmp/wms-telegram-settings-ui-check.py
```

The temporary script must:

- open `http://localhost:3000/settings`;
- select `X / Twitter`;
- assert masked Telegram state renders;
- verify dirty fields disable “发送测试消息”;
- capture console/framework/hydration errors;
- save screenshots outside the repository.

- [ ] **Step 7: Commit**

```bash
git add \
  wemedia-studio/app/settings/sections/TelegramSettingsCard.tsx \
  wemedia-studio/app/settings/sections/TelegramSettingsCard.test.tsx \
  wemedia-studio/app/settings/sections/XSection.tsx README.md
git commit -m "feat(telegram): complete bot settings UI"
```

- [ ] **Step 8: Real Telegram acceptance**

If saved Bot Token and Chat ID are configured, call:

```bash
curl -fsS -X POST http://localhost:8000/api/settings/telegram/test
```

Verify:

- API returns safe settings with `telegram_test_status=success`;
- Telegram receives exactly one fixed Chinese test message;
- no raw Bot Token appears in API/log output.

If credentials are not configured, record this single external verification as pending; do not claim real delivery from MockTransport tests.

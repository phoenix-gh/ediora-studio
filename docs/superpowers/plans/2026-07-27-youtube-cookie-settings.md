# YouTube Cookie Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure Settings-page field for a Netscape YouTube cookie file and use it for every `yt-dlp` request made during transcript extraction.

**Architecture:** Cookie text is a write-only application setting: browser clients receive only a boolean. Each transcript extraction creates one 0600 temporary Cookie file and shares it across metadata, subtitle, and fallback-audio downloads before automatic cleanup.

**Tech Stack:** FastAPI/Pydantic, SQLAlchemy application settings, Python `tempfile`, `yt-dlp`, Next.js/React, TypeScript, Vitest, pytest.

## Global Constraints

- Accept only Netscape `cookies.txt` content; reject HTTP `Cookie:` request headers with HTTP 422.
- Never return, log, commit, or retain Cookie text outside the scoped temporary file.
- Preserve anonymous `yt-dlp` behavior when no Cookie is configured.
- Use the same `--cookies` path for metadata, subtitle, and audio calls in an extraction.
- Clear the UI textarea after save and expose only whether a Cookie is configured.

---

### Task 1: Add the write-only settings API

**Files:**
- Modify: `backend/config.py:DEFAULTS`
- Modify: `backend/routers/settings.py:SettingsOut`, `SettingsUpdate`, `_build_out`, `update_settings`
- Create: `backend/tests/test_youtube_cookie_settings.py`

**Interfaces:**
- Produces `SettingsOut.youtube_cookies_set: bool`.
- Accepts `SettingsUpdate.youtube_cookies: str | None`.
- Produces `validate_youtube_cookies(value: str) -> str`; invalid input raises HTTP 422 with `YouTube Cookie 必须是 Netscape cookies.txt 格式`.

- [ ] **Step 1: Write the failing backend tests**

```python
def test_youtube_cookies_are_write_only_and_can_be_cleared(client):
    cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret"
    saved = client.put("/api/settings", json={"youtube_cookies": cookies})
    assert saved.status_code == 200
    assert saved.json()["youtube_cookies_set"] is True
    assert "secret" not in saved.text
    assert client.get("/api/settings").json()["youtube_cookies_set"] is True
    cleared = client.put("/api/settings", json={"youtube_cookies": ""})
    assert cleared.json()["youtube_cookies_set"] is False

def test_youtube_cookies_reject_http_cookie_header(client):
    response = client.put("/api/settings", json={"youtube_cookies": "Cookie: SID=secret"})
    assert response.status_code == 422
    assert response.json()["detail"] == "YouTube Cookie 必须是 Netscape cookies.txt 格式"
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `conda run -n wems pytest -q backend/tests/test_youtube_cookie_settings.py`

Expected: FAIL because `youtube_cookies_set` and the update field do not exist.

- [ ] **Step 3: Implement the minimal API**

```python
# backend/config.py
DEFAULTS["youtube_cookies"] = ""

def validate_youtube_cookies(value: str) -> str:
    normalized = value.replace("\r\n", "\n").strip()
    has_header = "# Netscape HTTP Cookie File" in normalized
    has_cookie_row = any(
        line and not line.startswith("#") and len(line.split("\t")) == 7
        for line in normalized.splitlines()
    )
    if normalized and not (has_header and has_cookie_row):
        raise HTTPException(422, "YouTube Cookie 必须是 Netscape cookies.txt 格式")
    return normalized
```

Add the boolean to `_build_out`, add the optional write-only input field, and save the validated value under `youtube_cookies`. Do not add raw or preview fields to `SettingsOut`.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `conda run -n wems pytest -q backend/tests/test_youtube_cookie_settings.py`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add backend/config.py backend/routers/settings.py backend/tests/test_youtube_cookie_settings.py && git commit -m "feat: store YouTube cookie settings securely"`

### Task 2: Apply the Cookie to every `yt-dlp` command

**Files:**
- Modify: `backend/youtube_transcript.py:extract_youtube_transcript`
- Modify: `backend/tests/test_youtube_transcript.py`

**Interfaces:**
- Consumes `config["youtube_cookies"]`.
- Produces `youtube_cookies_file(cookies: str) -> ContextManager[str | None]`.
- Uses the existing injected `command(*argv: str, timeout: float) -> Awaitable[str]` API.

- [ ] **Step 1: Write failing transcript tests**

```python
@pytest.mark.asyncio
async def test_extract_passes_one_cookie_file_to_metadata_and_subtitles():
    seen = await run_caption_extraction_with_config({"youtube_cookies": NETSCAPE_COOKIES})
    assert all("--cookies" in argv for argv in seen)
    paths = {argv[argv.index("--cookies") + 1] for argv in seen}
    assert len(paths) == 1

@pytest.mark.asyncio
async def test_extract_omits_cookie_flag_without_cookie_config():
    seen = await run_caption_extraction_with_config({})
    assert all("--cookies" not in argv for argv in seen)
```

The fake command must read the selected path during execution and assert that its contents start with `# Netscape HTTP Cookie File`; this verifies the real temporary-file behavior instead of only the command tuple.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `conda run -n wems pytest -q backend/tests/test_youtube_transcript.py -k cookies`

Expected: FAIL with the missing `--cookies` argument.

- [ ] **Step 3: Implement the scoped temporary-file helper**

```python
@contextmanager
def youtube_cookies_file(cookies: str) -> Iterator[str | None]:
    if not cookies.strip():
        yield None
        return
    with tempfile.TemporaryDirectory(prefix="wms-youtube-cookies-") as directory:
        path = Path(directory) / "cookies.txt"
        path.write_text(cookies, encoding="utf-8")
        path.chmod(0o600)
        yield str(path)

def ytdlp_args(*args: str, cookie_path: str | None) -> tuple[str, ...]:
    return (*args, *("--cookies", cookie_path) if cookie_path else ())
```

Wrap the complete `extract_youtube_transcript` body after URL validation in one `youtube_cookies_file` context. Build metadata, selected subtitle, and fallback audio commands through `ytdlp_args`, putting `--cookies` before each URL and retaining existing timeouts.

- [ ] **Step 4: Run focused and full transcript tests**

Run: `conda run -n wems pytest -q backend/tests/test_youtube_transcript.py`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add backend/youtube_transcript.py backend/tests/test_youtube_transcript.py && git commit -m "feat: use configured cookies for YouTube downloads"`

### Task 3: Add the YouTube settings UI

**Files:**
- Modify: `wemedia-studio/lib/api/settings.ts:AppSettings`, `SettingsUpdate`
- Modify: `wemedia-studio/lib/api/settings-test-fixtures.ts`
- Modify: `wemedia-studio/app/settings/SettingsClient.tsx:SectionId`, `NAV`, `SECTION_TITLE`, render branch
- Create: `wemedia-studio/app/settings/sections/YouTubeSection.tsx`
- Create: `wemedia-studio/app/settings/sections/YouTubeSection.test.tsx`

**Interfaces:**
- Consumes `AppSettings.youtube_cookies_set: boolean` and `updateSettings({ youtube_cookies: string })`.
- Produces `YouTubeSection({ settings, onSaved })` and never accesses a raw Cookie on `AppSettings`.

- [ ] **Step 1: Write failing UI tests**

```tsx
it('saves pasted cookies and clears the textarea', async () => {
  updateSettingsMock.mockResolvedValue(makeSettings({ youtube_cookies_set: true }))
  render(<YouTubeSection settings={makeSettings()} onSaved={onSaved} />)
  await userEvent.type(screen.getByLabelText('cookies.txt'), NETSCAPE_COOKIES)
  await userEvent.click(screen.getByRole('button', { name: '保存 Cookie' }))
  expect(updateSettingsMock).toHaveBeenCalledWith({ youtube_cookies: NETSCAPE_COOKIES })
  expect(screen.getByLabelText('cookies.txt')).toHaveValue('')
})

it('clears a configured cookie explicitly', async () => {
  render(<YouTubeSection settings={makeSettings({ youtube_cookies_set: true })} onSaved={onSaved} />)
  await userEvent.click(screen.getByRole('button', { name: '清除 Cookie' }))
  expect(updateSettingsMock).toHaveBeenCalledWith({ youtube_cookies: '' })
})
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `pnpm --dir wemedia-studio test -- app/settings/sections/YouTubeSection.test.tsx`

Expected: FAIL because `YouTubeSection` does not exist.

- [ ] **Step 3: Implement types, section, and navigation**

```tsx
// settings.ts
youtube_cookies_set: boolean
youtube_cookies?: string

// SettingsClient.tsx
{ id: 'youtube', label: 'YouTube', icon: Video, desc: 'Cookie · 字幕下载稳定性' }

// YouTubeSection.tsx
<Textarea id="youtube-cookies" value={cookies} onChange={event => setCookies(event.target.value)} />
<Button onClick={() => void save()} disabled={saving || !cookies.trim()}>保存 Cookie</Button>
{settings?.youtube_cookies_set && <Button variant="ghost" onClick={() => void clear()}>清除 Cookie</Button>}
```

Follow existing Card, Field, Button, toast, and `updateSettings` patterns. Include the Netscape format requirement and server-only storage notice. On successful save, call `onSaved(updated)` and clear the textarea.

- [ ] **Step 4: Run UI tests and type check**

Run: `pnpm --dir wemedia-studio test -- app/settings/sections/YouTubeSection.test.tsx`

Expected: PASS.

Run: `pnpm --dir wemedia-studio exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add wemedia-studio/lib/api/settings.ts wemedia-studio/lib/api/settings-test-fixtures.ts wemedia-studio/app/settings/SettingsClient.tsx wemedia-studio/app/settings/sections/YouTubeSection.tsx wemedia-studio/app/settings/sections/YouTubeSection.test.tsx && git commit -m "feat: add YouTube cookie settings UI"`

### Task 4: Run end-to-end verification

**Files:** Verify only; no source changes planned.

- [ ] **Step 1: Run backend regressions**

Run: `conda run -n wems pytest -q backend/tests`

Expected: PASS.

- [ ] **Step 2: Run frontend tests and production build**

Run: `pnpm --dir wemedia-studio test && pnpm --dir wemedia-studio build`

Expected: PASS.

- [ ] **Step 3: Rebuild services and verify secrecy**

Run: `docker compose build api web && docker compose up -d --force-recreate api web && curl -fsS http://localhost:8000/api/settings`

Expected: services healthy; response contains `youtube_cookies_set` and never contains the configured Cookie value.

- [ ] **Step 4: Manually retry one failed transcript after pasting a valid Cookie**

Expected: `yt-dlp` receives a temporary Cookie file. A remaining 429 is an upstream rate limit and must be reported separately from configuration correctness.

## Self-review

- Task 1 implements write-only persistence and exact validation.
- Task 2 covers metadata, subtitles, and audio with one temporary file.
- Task 3 covers the independent YouTube UI and browser secrecy.
- Task 4 covers full regressions, service startup, API secrecy, and runtime use.
- Public field, write-only field, and config key consistently use `youtube_cookies_set` and `youtube_cookies`.

# X Credential Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-managed, write-only pool of X `auth_token`/`ct0` credentials that feedgrab can rotate globally without binding accounts to subscriptions.

**Architecture:** PostgreSQL stores only account metadata, previews, slot ownership, and last manual-test status. Raw credentials live in permission-restricted `x_<slot>.json` files under the process-start `FEEDGRAB_DATA_DIR`; a focused file store provides atomic writes and reversible snapshots, while a separate router coordinates database commits and file compensation. Existing feedgrab session files remain read-only external sources and feedgrab keeps ownership of 429 rotation.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy async, httpx, feedgrab 0.24.x-compatible session files, pytest, Next.js 16.2, React 19, TypeScript, Vitest, Testing Library, Docker Compose.

## Global Constraints

- All enabled X credentials form one global rotation pool; subscriptions never carry a credential account ID.
- Managed input is exactly `name`, `auth_token`, `ct0`, and `enabled`.
- Raw `auth_token` and `ct0` values never enter PostgreSQL, API responses, browser state after save, or unredacted logs.
- Editing with both credential fields omitted preserves the existing file; supplying only one credential is a 422 validation error.
- Managed active files use `x_<credential_slot>.json`; disabled files use `x_<credential_slot>.disabled.json`.
- `credential_slot` is allocated around both database-owned slots and pre-existing external `x_<number>.json` files, and is never returned by the API.
- Session directories use mode `0700`; managed credential files use mode `0600` and same-directory atomic replacement.
- External `twitter.json`, `twitter_<number>.json`, `x.json`, and unowned `x_<number>.json` files are never edited or deleted.
- `FEEDGRAB_DATA_DIR` is fixed before backend process start and cannot be changed from the settings UI.
- X credential testing is explicit; saving does not call X.
- Test status is last-test state, not live monitoring: `untested | available | expired | rate_limited | failed`.
- No code in `/workspace/github/feedgrab` or installed site-packages is modified.
- feedgrab remains an optional runtime integration at import time; missing feedgrab fails X-only operations clearly without preventing API startup.
- No automatic X reply, quote, repost, or publish behavior is added.

---

## File Structure

### Backend

- Create `backend/x_credential_store.py`: resolve the session directory, allocate collision-free slots, atomically manage credential files, take/restore file snapshots, and report external sessions.
- Create `backend/x_credential_probe.py`: validate one credential pair against X and map upstream outcomes to bounded statuses.
- Create `backend/log_redaction.py`: redact X and Telegram credential patterns from backend/loguru messages.
- Create `backend/routers/x_accounts.py`: safe account-pool schemas and CRUD/test endpoints with database/file compensation.
- Modify `backend/models.py`: add `XCredentialAccount`.
- Modify `backend/main.py`: install log redaction and register the X account router.
- Modify `backend/feedgrab_client.py`: make aggregate auth status recognize all enabled managed and external session files without exposing secrets.
- Create `backend/tests/test_x_credential_store.py`: file permissions, slot allocation, enable/disable, snapshots, and external-file safety.
- Create `backend/tests/test_x_accounts_router.py`: API validation, write-only behavior, CRUD, compensation, and aggregate state.
- Create `backend/tests/test_x_credential_probe.py`: 2xx/401/403/429/network/invalid-response mapping.
- Create `backend/tests/test_x_credential_rotation.py`: actual feedgrab loader and 429 rotation against generated temp files.
- Create `backend/tests/test_log_redaction.py`: redaction of full tokens and feedgrab token identifiers.

### Frontend

- Create `wemedia-studio/lib/api/x-accounts.ts`: X account-pool types and API functions.
- Create `wemedia-studio/lib/api/x-accounts.test.ts`: request serialization and response safety tests.
- Create `wemedia-studio/app/settings/sections/XCredentialAccountsCard.tsx`: pool summary, account table, credential dialog, and actions.
- Create `wemedia-studio/app/settings/sections/XCredentialAccountsCard.test.tsx`: rendered CRUD/test/enable/disable interactions.
- Modify `wemedia-studio/app/settings/sections/XSection.tsx`: compose the account card and keep collection/response-profile settings distinct.
- Modify `wemedia-studio/lib/api/x.ts`: extend the backwards-compatible `XAuthStatus` aggregate fields.

### Deployment and documentation

- Modify `docker-compose.yml`: mount a persistent API session volume and set `FEEDGRAB_DATA_DIR=/app/sessions`.
- Modify `backend/.dockerignore`: exclude host session credentials from the image build context.
- Modify `README.md`: document UI-managed account rotation, external sessions, local directory configuration, and container persistence.

---

### Task 1: Credential Metadata and Atomic File Store

**Files:**
- Create: `backend/x_credential_store.py`
- Modify: `backend/models.py`
- Test: `backend/tests/test_x_credential_store.py`

**Interfaces:**
- Consumes: `feedgrab.config.get_cookie_dir()` when feedgrab is installed; otherwise `FEEDGRAB_DATA_DIR` or `Path.cwd() / "sessions"`.
- Produces:
  - `XCredentialAccount` ORM model.
  - `CredentialPair(auth_token: str, ct0: str)`.
  - `CredentialFileSnapshot(slot: int, active: bytes | None, disabled: bytes | None)`.
  - `CredentialFileStore.allocate_slot(reserved_slots: set[int]) -> int`.
  - `CredentialFileStore.write(slot: int, enabled: bool, pair: CredentialPair) -> CredentialFileSnapshot`.
  - `CredentialFileStore.set_enabled(slot: int, enabled: bool) -> CredentialFileSnapshot`.
  - `CredentialFileStore.delete(slot: int) -> CredentialFileSnapshot`.
  - `CredentialFileStore.restore(snapshot: CredentialFileSnapshot) -> None`.
  - `CredentialFileStore.read(slot: int) -> CredentialPair`.
  - `CredentialFileStore.external_sessions(managed_slots: set[int]) -> list[str]`.

- [ ] **Step 1: Write failing metadata and slot-allocation tests**

```python
def test_allocate_slot_skips_database_and_external_files(tmp_path):
    (tmp_path / "x_1.json").write_text('{"auth_token":"external","ct0":"csrf"}')
    store = CredentialFileStore(tmp_path)

    assert store.allocate_slot({2, 4}) == 3


def test_model_never_has_raw_credential_columns():
    columns = XCredentialAccount.__table__.columns.keys()
    assert "auth_token" not in columns
    assert "ct0" not in columns
    assert {
        "name", "enabled", "credential_slot",
        "auth_token_preview", "ct0_preview",
        "test_status", "last_tested_at", "last_test_error",
    }.issubset(columns)
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_credential_store.py -q
```

Expected: collection/import failure because `x_credential_store` and `XCredentialAccount` do not exist.

- [ ] **Step 3: Add the metadata model and collision-free allocator**

Add to `backend/models.py`:

```python
class XCredentialAccount(Base):
    __tablename__ = "x_credential_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    credential_slot: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    auth_token_preview: Mapped[str] = mapped_column(String, default="")
    ct0_preview: Mapped[str] = mapped_column(String, default="")
    test_status: Mapped[str] = mapped_column(String, default="untested", index=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )
```

Create the initial store boundary:

```python
def resolve_session_dir() -> Path:
    configured = os.getenv("FEEDGRAB_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        from feedgrab.config import get_cookie_dir
    except ImportError:
        return (Path.cwd() / "sessions").resolve()
    return Path(get_cookie_dir()).expanduser().resolve()


MANAGED_ACTIVE = re.compile(r"^x_(\d+)\.json$")
MANAGED_DISABLED = re.compile(r"^x_(\d+)\.disabled\.json$")


@dataclass(frozen=True)
class CredentialPair:
    auth_token: str
    ct0: str


@dataclass(frozen=True)
class CredentialFileSnapshot:
    slot: int
    active: bytes | None
    disabled: bytes | None


class CredentialFileError(RuntimeError):
    pass


class CredentialFileStore:
    def __init__(self, directory: Path | None = None):
        self.directory = directory or resolve_session_dir()

    def allocate_slot(self, reserved_slots: set[int]) -> int:
        occupied = set(reserved_slots)
        if self.directory.exists():
            for path in self.directory.iterdir():
                match = MANAGED_ACTIVE.match(path.name) or MANAGED_DISABLED.match(path.name)
                if match:
                    occupied.add(int(match.group(1)))
        slot = 1
        while slot in occupied:
            slot += 1
        return slot
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_credential_store.py -q
```

Expected: metadata and allocation tests pass.

- [ ] **Step 5: Write failing file-lifecycle tests**

```python
def test_write_disable_restore_and_delete_are_reversible(tmp_path):
    store = CredentialFileStore(tmp_path)
    original = CredentialPair("token-a", "ct0-a")
    snapshot = store.write(3, True, original)

    active = tmp_path / "x_3.json"
    assert json.loads(active.read_text()) == {
        "auth_token": "token-a",
        "ct0": "ct0-a",
    }
    assert stat.S_IMODE(active.stat().st_mode) == 0o600
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700

    disable_snapshot = store.set_enabled(3, False)
    assert not active.exists()
    assert (tmp_path / "x_3.disabled.json").exists()

    store.restore(disable_snapshot)
    assert active.exists()
    assert not (tmp_path / "x_3.disabled.json").exists()

    delete_snapshot = store.delete(3)
    assert not active.exists()
    store.restore(delete_snapshot)
    assert store.read(3) == original
    assert snapshot.active is None


def test_external_files_are_reported_but_untouched(tmp_path):
    external = tmp_path / "twitter.json"
    external.write_text('{"cookies":[]}')
    store = CredentialFileStore(tmp_path)

    assert store.external_sessions(set()) == ["twitter.json"]
    store.write(2, True, CredentialPair("managed", "csrf"))
    assert external.read_text() == '{"cookies":[]}'
```

- [ ] **Step 6: Run the file tests and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_credential_store.py -q
```

Expected: failures because file lifecycle methods are missing.

- [ ] **Step 7: Implement atomic file lifecycle and snapshots**

Use compact JSON and same-directory `os.replace`:

```python
def _atomic_write(self, path: Path, payload: bytes) -> None:
    self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(self.directory, 0o700)
    fd, temp_name = tempfile.mkstemp(prefix=".x-credential-", dir=self.directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _payload(pair: CredentialPair) -> bytes:
    return json.dumps(
        {"auth_token": pair.auth_token, "ct0": pair.ct0},
        separators=(",", ":"),
    ).encode()
```

Add the concrete lifecycle methods:

```python
def _paths(self, slot: int) -> tuple[Path, Path]:
    return (
        self.directory / f"x_{slot}.json",
        self.directory / f"x_{slot}.disabled.json",
    )


def snapshot(self, slot: int) -> CredentialFileSnapshot:
    active, disabled = self._paths(slot)
    return CredentialFileSnapshot(
        slot=slot,
        active=active.read_bytes() if active.exists() else None,
        disabled=disabled.read_bytes() if disabled.exists() else None,
    )


def write(
    self,
    slot: int,
    enabled: bool,
    pair: CredentialPair,
) -> CredentialFileSnapshot:
    previous = self.snapshot(slot)
    active, disabled = self._paths(slot)
    destination, obsolete = (active, disabled) if enabled else (disabled, active)
    try:
        self._atomic_write(destination, _payload(pair))
        obsolete.unlink(missing_ok=True)
    except Exception:
        self.restore(previous)
        raise
    return previous


def set_enabled(self, slot: int, enabled: bool) -> CredentialFileSnapshot:
    previous = self.snapshot(slot)
    active, disabled = self._paths(slot)
    source, destination = (disabled, active) if enabled else (active, disabled)
    if not source.exists() or destination.exists():
        raise CredentialFileError("托管凭据文件状态冲突")
    os.replace(source, destination)
    os.chmod(destination, 0o600)
    return previous


def delete(self, slot: int) -> CredentialFileSnapshot:
    previous = self.snapshot(slot)
    active, disabled = self._paths(slot)
    active.unlink(missing_ok=True)
    disabled.unlink(missing_ok=True)
    return previous


def restore(self, previous: CredentialFileSnapshot) -> None:
    active, disabled = self._paths(previous.slot)
    active.unlink(missing_ok=True)
    disabled.unlink(missing_ok=True)
    if previous.active is not None:
        self._atomic_write(active, previous.active)
    if previous.disabled is not None:
        self._atomic_write(disabled, previous.disabled)


def read(self, slot: int) -> CredentialPair:
    active, disabled = self._paths(slot)
    existing = [path for path in (active, disabled) if path.exists()]
    if len(existing) != 1:
        raise CredentialFileError("托管凭据文件不存在或状态冲突")
    try:
        value = json.loads(existing[0].read_text())
        auth_token = value["auth_token"].strip()
        ct0 = value["ct0"].strip()
    except (OSError, json.JSONDecodeError, KeyError, AttributeError) as exc:
        raise CredentialFileError("托管凭据文件格式无效") from exc
    if not auth_token or not ct0:
        raise CredentialFileError("托管凭据字段为空")
    return CredentialPair(auth_token, ct0)


def external_sessions(self, managed_slots: set[int]) -> list[str]:
    if not self.directory.exists():
        return []
    external: list[str] = []
    for path in self.directory.iterdir():
        name = path.name
        match = MANAGED_ACTIVE.match(name)
        is_named_external = bool(
            name == "x.json"
            or re.fullmatch(r"twitter(?:_\d+)?\.json", name)
            or (match and int(match.group(1)) not in managed_slots)
        )
        if path.is_file() and is_named_external:
            external.append(name)
    return sorted(external)
```

Define `CredentialFileSnapshot` as the immutable dataclass in the interface block and `CredentialFileError(RuntimeError)`. Bind these functions as `CredentialFileStore` methods; `_payload` remains a module helper. Every restored or newly written file is mode `0600`, and the directory is mode `0700`.

- [ ] **Step 8: Run Task 1 tests and commit**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_credential_store.py -q
git diff --check
```

Expected: all store tests pass and no whitespace errors.

Commit:

```bash
git add backend/models.py backend/x_credential_store.py backend/tests/test_x_credential_store.py
git commit -m "feat(x): add credential file store"
```

---

### Task 2: Safe Account CRUD API and Startup Consistency

**Files:**
- Create: `backend/routers/x_accounts.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_x_accounts_router.py`

**Interfaces:**
- Consumes: `XCredentialAccount`, `CredentialFileStore`, `CredentialPair`, and reversible snapshots from Task 1.
- Produces:
  - `GET /api/x/accounts`.
  - `POST /api/x/accounts`.
  - `PATCH /api/x/accounts/{account_id}`.
  - `DELETE /api/x/accounts/{account_id}`.
  - `reconcile_x_credential_accounts(db, store) -> list[str]`.
  - Safe output shape `XCredentialPoolOut`; list, create, patch, delete, and test all return this complete pool shape.

- [ ] **Step 1: Write failing CRUD and write-only API tests**

Create a fixture that sets both SQLite and a temp session directory before importing `main`:

```python
import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'x-accounts.db'}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("FEEDGRAB_DATA_DIR", str(tmp_path / "sessions"))
    for name in list(sys.modules):
        if name.startswith((
            "database", "models", "main", "routers", "config",
            "x_credential", "feedgrab_client",
        )):
            sys.modules.pop(name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    from main import app
    return TestClient(app)


def session_dir() -> Path:
    return Path(os.environ["FEEDGRAB_DATA_DIR"])


def create_account(client, name="采集账号 A"):
    response = client.post("/api/x/accounts", json={
        "name": name,
        "auth_token": "secret-auth",
        "ct0": "secret-csrf",
        "enabled": True,
    })
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["accounts"] if item["name"] == name)


def managed_active_file() -> Path:
    return next(
        path for path in session_dir().glob("x_[0-9]*.json")
        if ".disabled." not in path.name
    )
```

Add observable behavior tests:

```python
def test_create_account_writes_file_without_returning_secrets(client, tmp_path):
    response = client.post("/api/x/accounts", json={
        "name": "采集账号 A",
        "auth_token": "secret-auth",
        "ct0": "secret-csrf",
        "enabled": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    account = next(item for item in body["accounts"] if item["name"] == "采集账号 A")
    assert account["auth_token_preview"] == "…auth"
    assert account["ct0_preview"] == "…csrf"
    serialized = response.text
    assert "secret-auth" not in serialized
    assert "secret-csrf" not in serialized
    assert body["managed_enabled"] == 1


def test_patch_requires_both_credentials_and_blank_pair_preserves_file(client):
    account = create_account(client)
    before = managed_active_file().read_bytes()
    partial = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"auth_token": "replacement"},
    )
    assert partial.status_code == 422
    kept = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"name": "重命名", "auth_token": "", "ct0": ""},
    )
    assert kept.status_code == 200
    assert managed_active_file().read_bytes() == before


def test_disable_and_delete_only_touch_owned_slot(client):
    external = session_dir() / "x_1.json"
    external.write_text('{"auth_token":"external","ct0":"external-csrf"}')
    account = create_account(client)
    assert external.exists()

    disabled = client.patch(
        f"/api/x/accounts/{account['id']}",
        json={"enabled": False},
    )
    assert disabled.status_code == 200
    assert list(session_dir().glob("x_*.disabled.json"))

    deleted = client.delete(f"/api/x/accounts/{account['id']}")
    assert deleted.status_code == 200
    assert external.exists()
```

- [ ] **Step 2: Run the router tests and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_accounts_router.py -q
```

Expected: 404 or import failure because the router is not registered.

- [ ] **Step 3: Define safe schemas and create/list endpoints**

Use Pydantic paired-field validation:

```python
class XCredentialAccountCreate(BaseModel):
    name: str
    auth_token: str
    ct0: str
    enabled: bool = True

    @model_validator(mode="after")
    def validate_fields(self):
        self.name = self.name.strip()
        self.auth_token = self.auth_token.strip()
        self.ct0 = self.ct0.strip()
        if not self.name or not self.auth_token or not self.ct0:
            raise ValueError("账号名称、auth_token 和 ct0 均不能为空")
        return self


class XCredentialAccountPatch(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    auth_token: str | None = None
    ct0: str | None = None

    @model_validator(mode="after")
    def validate_pair(self):
        if self.name is not None:
            self.name = self.name.strip()
            if not self.name:
                raise ValueError("账号名称不能为空")
        supplied = [bool((self.auth_token or "").strip()), bool((self.ct0 or "").strip())]
        if any(supplied) and not all(supplied):
            raise ValueError("auth_token 和 ct0 必须同时填写")
        return self
```

Return only:

```python
class XCredentialAccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    enabled: bool
    auth_token_preview: str
    ct0_preview: str
    test_status: str
    last_tested_at: datetime | None
    last_test_error: str
    created_at: datetime
    updated_at: datetime


class XCredentialPoolOut(BaseModel):
    accounts: list[XCredentialAccountOut]
    external_sessions: list[str]
    managed_enabled: int
    total_accounts: int
    available_accounts: int


def credential_preview(value: str) -> str:
    return f"…{value[-4:]}" if len(value) > 4 else "已配置"


def reset_test_status(account: XCredentialAccount) -> None:
    account.test_status = "untested"
    account.last_tested_at = None
    account.last_test_error = ""
```

For create, select all reserved slots, allocate a free slot, `flush()` the row, write the file, then commit. On any commit exception, call `store.restore(snapshot)` and roll back.

- [ ] **Step 4: Implement patch/delete compensation and pool summary**

Patch flow:

```python
snapshot = None
try:
    if replacing_credentials:
        snapshot = store.write(account.credential_slot, next_enabled, pair)
        account.auth_token_preview = credential_preview(pair.auth_token)
        account.ct0_preview = credential_preview(pair.ct0)
        reset_test_status(account)
    elif changing_enabled:
        snapshot = store.set_enabled(account.credential_slot, next_enabled)
    if body.name is not None:
        account.name = body.name
    if body.enabled is not None:
        account.enabled = body.enabled
    await db.commit()
except Exception:
    await db.rollback()
    if snapshot is not None:
        store.restore(snapshot)
    raise
```

Delete uses `store.delete()` before commit and restores the snapshot if commit fails. The list response derives external filenames through `external_sessions(managed_slots)` and never includes `credential_slot`.

- [ ] **Step 5: Add startup consistency behavior**

Write tests first:

```python
def test_reconcile_marks_missing_managed_file_failed(client):
    account = create_account(client)
    managed_active_file().unlink()

    async def reconcile():
        from database import SessionLocal
        from routers.x_accounts import reconcile_x_credential_accounts
        from x_credential_store import CredentialFileStore

        async with SessionLocal() as db:
            await reconcile_x_credential_accounts(db, CredentialFileStore(session_dir()))

    asyncio.run(reconcile())
    result = client.get("/api/x/accounts").json()
    row = next(item for item in result["accounts"] if item["id"] == account["id"])
    assert row["test_status"] == "failed"
    assert "凭据文件不存在" in row["last_test_error"]
```

Implement `reconcile_x_credential_accounts()` so it:

- marks missing or malformed managed files `failed`;
- moves an existing managed file to match `enabled`;
- reports conflicts instead of overwriting unknown files;
- leaves every external session untouched.

Call reconciliation during FastAPI lifespan after `init_db()` and before scheduler registration:

```python
from database import SessionLocal
from loguru import logger
from routers.x_accounts import reconcile_x_credential_accounts
from x_credential_store import CredentialFileStore

try:
    async with SessionLocal() as db:
        errors = await reconcile_x_credential_accounts(db, CredentialFileStore())
        for error in errors:
            logger.warning("X 凭据对账：{}", error)
except Exception:
    logger.error("X 凭据启动对账失败；账号接口仍可用于修复")
```

A reconciliation error never logs exception text or credentials and does not prevent unrelated API startup. Import `x_accounts` in the existing router import block and register it with `app.include_router(x_accounts.router, prefix="/api")`.

- [ ] **Step 6: Run Task 2 tests and commit**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_accounts_router.py backend/tests/test_x_credential_store.py -q
git diff --check
```

Expected: all CRUD, write-only, compensation, collision, and reconciliation tests pass.

Commit:

```bash
git add backend/main.py backend/routers/x_accounts.py backend/tests/test_x_accounts_router.py
git commit -m "feat(x): expose credential pool APIs"
```

---

### Task 3: Credential Probe, Aggregate Auth Status, Rotation, and Redaction

**Files:**
- Create: `backend/x_credential_probe.py`
- Create: `backend/log_redaction.py`
- Modify: `backend/feedgrab_client.py`
- Modify: `backend/main.py`
- Modify: `backend/routers/x_accounts.py`
- Test: `backend/tests/test_x_credential_probe.py`
- Test: `backend/tests/test_x_credential_rotation.py`
- Test: `backend/tests/test_log_redaction.py`
- Test: `backend/tests/test_x_router.py`

**Interfaces:**
- Consumes: account store/API from Tasks 1–2; `feedgrab.fetchers.twitter_cookies.BEARER_TOKEN` and rotation functions only inside explicit X operations.
- Produces:
  - `CredentialProbeResult(status: str, error: str)`.
  - `async probe_x_credentials(pair, client=None) -> CredentialProbeResult`.
  - `POST /api/x/accounts/{account_id}/test`.
  - `redact_secret_text(value: str) -> str`.
  - Backwards-compatible `/api/x/auth-status` with `managed_accounts`, `external_sessions`, `total_accounts`, `available_accounts`.

- [ ] **Step 1: Write failing probe mapping tests**

```python
async def run_probe(transport: httpx.MockTransport) -> CredentialProbeResult:
    async with httpx.AsyncClient(transport=transport) as client:
        return await probe_x_credentials(
            CredentialPair("secret-auth", "secret-csrf"),
            client=client,
        )


@pytest.mark.parametrize(("status_code", "payload", "expected"), [
    (200, {"screen_name": "example"}, "available"),
    (401, {"errors": []}, "expired"),
    (403, {"errors": []}, "expired"),
    (429, {"errors": []}, "rate_limited"),
    (500, {"errors": []}, "failed"),
])
def test_probe_maps_x_responses(status_code, payload, expected):
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(status_code, json=payload)
    )
    result = asyncio.run(run_probe(transport))
    assert result.status == expected
    assert "secret-auth" not in result.error
    assert "secret-csrf" not in result.error


def test_probe_rejects_non_object_success_payload():
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(200, json=["not", "an", "object"])
    )
    assert asyncio.run(run_probe(transport)).status == "failed"
```

- [ ] **Step 2: Run probe tests and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_credential_probe.py -q
```

Expected: import failure because `x_credential_probe` does not exist.

- [ ] **Step 3: Implement the explicit X account probe**

```python
X_ACCOUNT_SETTINGS_URL = "https://x.com/i/api/1.1/account/settings.json"


@dataclass(frozen=True)
class CredentialProbeResult:
    status: str
    error: str


async def probe_x_credentials(
    pair: CredentialPair,
    *,
    client: httpx.AsyncClient | None = None,
) -> CredentialProbeResult:
    try:
        from feedgrab.fetchers.twitter_cookies import BEARER_TOKEN, DEFAULT_USER_AGENT
    except ImportError:
        return CredentialProbeResult("failed", "feedgrab 未安装，无法测试 X 凭据")

    headers = {
        "authorization": f"Bearer {BEARER_TOKEN}",
        "cookie": f"auth_token={pair.auth_token}; ct0={pair.ct0}",
        "x-csrf-token": pair.ct0,
        "x-twitter-active-user": "yes",
        "user-agent": DEFAULT_USER_AGENT,
    }
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=15.0) as owned_client:
                response = await owned_client.get(X_ACCOUNT_SETTINGS_URL, headers=headers)
        else:
            response = await client.get(X_ACCOUNT_SETTINGS_URL, headers=headers)
    except httpx.RequestError:
        return CredentialProbeResult("failed", "连接 X 失败")

    if response.status_code == 429:
        return CredentialProbeResult("rate_limited", "X 账号当前被限流")
    if response.status_code in {401, 403}:
        return CredentialProbeResult("expired", "X 凭据已失效或无权限")
    if not 200 <= response.status_code < 300:
        return CredentialProbeResult("failed", f"X 返回 HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        return CredentialProbeResult("failed", "X 返回了无效 JSON")
    if not isinstance(payload, dict):
        return CredentialProbeResult("failed", "X 返回结构不符合预期")
    return CredentialProbeResult("available", "")
```

The router reads the account file, calls the probe, persists `test_status`, UTC `last_tested_at`, and a maximum 500-character redacted error.

- [ ] **Step 4: Write and implement aggregate auth-status tests**

Extend the existing test:

```python
def test_auth_status_counts_managed_and_external_accounts(client, monkeypatch):
    create_account(client)
    (session_dir() / "x.json").write_text(
        '{"auth_token":"external-auth","ct0":"external-csrf"}'
    )
    body = client.get("/api/x/auth-status").json()
    assert body["ready"] is True
    assert body["managed_accounts"] == 1
    assert body["external_sessions"] == 1
    assert body["total_accounts"] >= 2
    assert body["available_accounts"] <= body["total_accounts"]
```

Keep `ready` and `hint` exactly present for old callers. Use optional feedgrab count functions when available; otherwise derive total recognized files and set `available_accounts` equal to recognized enabled sources because no in-process rate-limit state exists.

- [ ] **Step 5: Write and implement the actual feedgrab rotation test**

```python
def reset_rotation_globals(module):
    module._rate_limited_accounts.clear()
    module._current_account_key = ""


def test_generated_files_rotate_after_first_account_is_rate_limited(tmp_path, monkeypatch):
    from feedgrab.fetchers import twitter_cookies

    reset_rotation_globals(twitter_cookies)
    monkeypatch.setattr(twitter_cookies, "COOKIE_DIR", tmp_path)
    monkeypatch.setattr(twitter_cookies, "SESSION_DIR", tmp_path)

    store = CredentialFileStore(tmp_path)
    store.write(1, True, CredentialPair("account-one", "csrf-one"))
    store.write(2, True, CredentialPair("account-two", "csrf-two"))

    first = twitter_cookies.load_twitter_cookies()
    assert first["auth_token"] == "account-one"
    twitter_cookies.mark_cookie_rate_limited(first)
    second = twitter_cookies.load_twitter_cookies()
    assert second["auth_token"] == "account-two"

    store.set_enabled(2, False)
    reset_rotation_globals(twitter_cookies)
    assert twitter_cookies.count_total_accounts() == 1
```

This test must run with `conda run -n wems`; it is not replaced with a mock of feedgrab.

- [ ] **Step 6: Add credential log redaction**

Write RED tests:

```python
def test_redacts_full_and_prefixed_credentials():
    text = (
        "auth_token=abcdefgh123456 ct0: csrf-secret "
        "https://api.telegram.org/bot123456:ABC-secret/sendMessage"
    )
    redacted = redact_secret_text(text)
    assert "abcdefgh123456" not in redacted
    assert "csrf-secret" not in redacted
    assert "123456:ABC-secret" not in redacted
    assert "auth_token=***" in redacted
```

Implement bounded regular expressions in `log_redaction.py`:

```python
import re

from loguru import logger


AUTH_TOKEN = re.compile(r"(?i)(auth_token\s*[:=]\s*)[^;\s,]+")
CT0 = re.compile(r"(?i)(ct0\s*[:=]\s*)[^;\s,]+")
TELEGRAM_BOT_URL = re.compile(r"(?i)(api\.telegram\.org/bot)[^/\s]+")


def redact_secret_text(value: str) -> str:
    redacted = AUTH_TOKEN.sub(r"\1***", value)
    redacted = CT0.sub(r"\1***", redacted)
    return TELEGRAM_BOT_URL.sub(r"\1***", redacted)


def install_log_redaction() -> None:
    def patch(record: dict) -> None:
        record["message"] = redact_secret_text(str(record["message"]))

    logger.configure(patcher=patch)
```

Then install the loguru patcher at the top of `main.py` after `.env` loading and before router/feedgrab imports:

```python
from log_redaction import install_log_redaction

install_log_redaction()
```

- [ ] **Step 7: Run Task 3 tests and commit**

Run:

```bash
conda run -n wems pytest \
  backend/tests/test_x_credential_probe.py \
  backend/tests/test_x_credential_rotation.py \
  backend/tests/test_log_redaction.py \
  backend/tests/test_x_accounts_router.py \
  backend/tests/test_x_router.py -q
git diff --check
```

Expected: all probe, aggregate, rotation, and redaction tests pass.

Commit:

```bash
git add \
  backend/x_credential_probe.py backend/log_redaction.py \
  backend/feedgrab_client.py backend/main.py backend/routers/x_accounts.py \
  backend/tests/test_x_credential_probe.py \
  backend/tests/test_x_credential_rotation.py \
  backend/tests/test_log_redaction.py backend/tests/test_x_router.py
git commit -m "feat(x): test and monitor credential pool"
```

---

### Task 4: Frontend X Account API Client

**Files:**
- Create: `wemedia-studio/lib/api/x-accounts.ts`
- Create: `wemedia-studio/lib/api/x-accounts.test.ts`
- Modify: `wemedia-studio/lib/api/x.ts`

**Interfaces:**
- Consumes: backend endpoints from Tasks 2–3 and shared `apiFetch`.
- Produces:
  - `XCredentialAccount`.
  - `XCredentialPool`.
  - `CreateXCredentialAccountInput`.
  - `PatchXCredentialAccountInput`.
  - `listXCredentialAccounts() -> Promise<XCredentialPool>`.
  - `createXCredentialAccount(input) -> Promise<XCredentialPool>`.
  - `patchXCredentialAccount(id, input) -> Promise<XCredentialPool>`.
  - `deleteXCredentialAccount(id) -> Promise<XCredentialPool>`.
  - `testXCredentialAccount(id) -> Promise<XCredentialPool>`.

- [ ] **Step 1: Write failing request-serialization tests**

```typescript
const poolFixture: XCredentialPool = {
  accounts: [{
    id: 7,
    name: '采集账号 A',
    enabled: true,
    auth_token_preview: '…auth',
    ct0_preview: '…csrf',
    test_status: 'untested',
    last_tested_at: null,
    last_test_error: '',
    created_at: '2026-07-25T13:00:00Z',
    updated_at: '2026-07-25T13:00:00Z',
  }],
  external_sessions: ['twitter.json'],
  managed_enabled: 1,
  total_accounts: 2,
  available_accounts: 2,
}
const accountFixture = poolFixture.accounts[0]
const jsonResponse = (value: unknown) => new Response(
  JSON.stringify(value),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)


it('creates, updates, tests, and deletes X credential accounts', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(poolFixture))
  vi.stubGlobal('fetch', fetchMock)

  await createXCredentialAccount({
    name: '采集账号 A',
    auth_token: 'auth',
    ct0: 'csrf',
    enabled: true,
  })
  await patchXCredentialAccount(7, { enabled: false })
  await testXCredentialAccount(7)
  await deleteXCredentialAccount(7)

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    'http://localhost:8000/api/x/accounts',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        name: '采集账号 A',
        auth_token: 'auth',
        ct0: 'csrf',
        enabled: true,
      }),
    }),
  )
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    'http://localhost:8000/api/x/accounts/7/test',
    expect.objectContaining({ method: 'POST' }),
  )
  expect(fetchMock).toHaveBeenNthCalledWith(
    4,
    'http://localhost:8000/api/x/accounts/7',
    expect.objectContaining({ method: 'DELETE' }),
  )
})


it('does not define raw credentials on returned account types', () => {
  const account: XCredentialAccount = accountFixture
  expect('auth_token' in account).toBe(false)
  expect('ct0' in account).toBe(false)
})
```

- [ ] **Step 2: Run the client tests and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test lib/api/x-accounts.test.ts
```

Expected: import failure because `x-accounts.ts` does not exist.

- [ ] **Step 3: Implement exact client types and functions**

```typescript
export type XCredentialTestStatus =
  | 'untested'
  | 'available'
  | 'expired'
  | 'rate_limited'
  | 'failed'

export interface XCredentialAccount {
  id: number
  name: string
  enabled: boolean
  auth_token_preview: string
  ct0_preview: string
  test_status: XCredentialTestStatus
  last_tested_at: string | null
  last_test_error: string
  created_at: string
  updated_at: string
}

export interface XCredentialPool {
  accounts: XCredentialAccount[]
  external_sessions: string[]
  managed_enabled: number
  total_accounts: number
  available_accounts: number
}
```

Each function calls the exact paths in the interface block via `apiFetch`.

- [ ] **Step 4: Run Task 4 tests and commit**

Run:

```bash
pnpm test lib/api/x-accounts.test.ts
pnpm exec tsc --noEmit
```

Expected: API tests and TypeScript pass.

Commit:

```bash
git add wemedia-studio/lib/api/x-accounts.ts wemedia-studio/lib/api/x-accounts.test.ts wemedia-studio/lib/api/x.ts
git commit -m "feat(x): add credential pool client"
```

---

### Task 5: X Credential Pool Settings UI

**Files:**
- Create: `wemedia-studio/app/settings/sections/XCredentialAccountsCard.tsx`
- Create: `wemedia-studio/app/settings/sections/XCredentialAccountsCard.test.tsx`
- Modify: `wemedia-studio/app/settings/sections/XSection.tsx`

**Interfaces:**
- Consumes: all Task 4 API functions and existing shadcn `Button`, `Input`, `Label`, `Switch`, and `Dialog`.
- Produces: `<XCredentialAccountsCard />`, a self-loading settings card with no raw credential props.

- [ ] **Step 1: Write failing rendered-state tests**

Use the real component with API-boundary mocks:

```typescript
// @vitest-environment jsdom
const poolFixture: XCredentialPool = {
  accounts: [{
    id: 7,
    name: '采集账号 A',
    enabled: true,
    auth_token_preview: '…auth',
    ct0_preview: '…csrf',
    test_status: 'available',
    last_tested_at: '2026-07-25T13:00:00Z',
    last_test_error: '',
    created_at: '2026-07-25T12:00:00Z',
    updated_at: '2026-07-25T13:00:00Z',
  }],
  external_sessions: ['twitter.json'],
  managed_enabled: 1,
  total_accounts: 2,
  available_accounts: 2,
}
const emptyPool: XCredentialPool = {
  accounts: [],
  external_sessions: [],
  managed_enabled: 0,
  total_accounts: 0,
  available_accounts: 0,
}

vi.mock('@/lib/api/x-accounts', () => ({
  listXCredentialAccounts: vi.fn(),
  createXCredentialAccount: vi.fn(),
  patchXCredentialAccount: vi.fn(),
  deleteXCredentialAccount: vi.fn(),
  testXCredentialAccount: vi.fn(),
}))

it('renders pool counts and masked account state', async () => {
  vi.mocked(listXCredentialAccounts).mockResolvedValue(poolFixture)
  render(<XCredentialAccountsCard />)

  expect(await screen.findByText('采集账号 A')).toBeInTheDocument()
  expect(screen.getByText('…auth')).toBeInTheDocument()
  expect(screen.getByText('外部 session：1')).toBeInTheDocument()
  expect(screen.queryByText('secret-auth')).not.toBeInTheDocument()
})


it('creates an account with a paired credential payload', async () => {
  vi.mocked(listXCredentialAccounts).mockResolvedValue(emptyPool)
  vi.mocked(createXCredentialAccount).mockResolvedValue(poolFixture)
  const user = userEvent.setup()
  render(<XCredentialAccountsCard />)

  await user.click(await screen.findByRole('button', { name: '添加账号' }))
  await user.type(screen.getByLabelText('账号名称'), '采集账号 A')
  await user.type(screen.getByLabelText('auth_token'), 'secret-auth')
  await user.type(screen.getByLabelText('ct0'), 'secret-csrf')
  await user.click(screen.getByRole('button', { name: '保存账号' }))

  expect(createXCredentialAccount).toHaveBeenCalledWith({
    name: '采集账号 A',
    auth_token: 'secret-auth',
    ct0: 'secret-csrf',
    enabled: true,
  })
})
```

Add separate tests for:

- one-field-only validation without calling the API;
- editing with blank credentials;
- enable/disable action;
- test button loading and refreshed result;
- confirmed delete and cancelled delete;
- cleaned API error text.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test app/settings/sections/XCredentialAccountsCard.test.tsx
```

Expected: import failure because the component does not exist.

- [ ] **Step 3: Build the focused account card**

State shape:

```typescript
type FormState = {
  id: number | null
  name: string
  auth_token: string
  ct0: string
  enabled: boolean
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  auth_token: '',
  ct0: '',
  enabled: true,
}
```

Behavior:

- load the pool once on mount;
- refresh from every mutation response rather than patching local account objects;
- keep one `actingId` plus an action name to prevent duplicate account actions;
- use password inputs with `autoComplete="new-password"`;
- never seed edit inputs with previews;
- disable save when name is blank or exactly one credential is nonblank;
- use `confirm()` before delete;
- map test statuses to Chinese labels: 未测试、可用、已失效、被限流、测试失败;
- display errors from `Error.message` without credentials.

- [ ] **Step 4: Integrate the card and clarify terminology**

In `XSection.tsx`:

- render `<XCredentialAccountsCard />` immediately below the X/feedgrab heading;
- remove the old single “认证状态/如何登录” blocks;
- keep collection interval and realtime-response controls;
- rename the profile label to `建议使用的发布账号画像`;
- retain external login guidance as compact copy inside the new card, not as raw shell environment examples.

- [ ] **Step 5: Run Task 5 tests, TypeScript, and rendered smoke**

Run:

```bash
pnpm test app/settings/sections/XCredentialAccountsCard.test.tsx
pnpm exec tsc --noEmit
```

Then use the existing Playwright-capable `wems` environment against the running dev server:

Create `/tmp/wms-x-accounts-ui-check.py` with:

```python
from pathlib import Path

from playwright.sync_api import sync_playwright


errors: list[str] = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on(
        "console",
        lambda message: errors.append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://localhost:3000/settings", wait_until="networkidle")
    page.get_by_role("tab", name="X / Twitter").click()
    page.get_by_text("X 采集账号池", exact=True).wait_for()
    page.get_by_role("button", name="添加账号").click()
    page.get_by_role("dialog").wait_for()
    page.keyboard.press("Escape")
    page.screenshot(path="/tmp/wms-x-accounts-settings.png", full_page=True)
    browser.close()

framework_errors = [
    message for message in errors
    if "hydration" in message.lower()
    or "uncaught" in message.lower()
    or "next" in message.lower()
]
assert not framework_errors, framework_errors
assert Path("/tmp/wms-x-accounts-settings.png").is_file()
```

Create this temporary file with `apply_patch`, then run:

```bash
conda run --no-capture-output -n wems python /tmp/wms-x-accounts-ui-check.py
```

The temporary script must:

- open `http://localhost:3000/settings`;
- click `X / Twitter`;
- assert `X 采集账号池` is visible;
- open and close the add dialog;
- capture console errors and fail on hydration/framework errors;
- save a screenshot outside the repository.

Expected: component tests, typecheck, and rendered interaction pass.

- [ ] **Step 6: Commit**

```bash
git add \
  wemedia-studio/app/settings/sections/XCredentialAccountsCard.tsx \
  wemedia-studio/app/settings/sections/XCredentialAccountsCard.test.tsx \
  wemedia-studio/app/settings/sections/XSection.tsx
git commit -m "feat(x): manage collection accounts in settings"
```

---

### Task 6: Persistence, Documentation, and Full Verification

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/.dockerignore`
- Modify: `README.md`
- Test: all backend/frontend tests from previous tasks.

**Interfaces:**
- Consumes: completed backend and frontend account pool.
- Produces: persistent `/app/sessions` in Compose and operator instructions that do not require copying secrets into an image.

- [ ] **Step 1: Write a failing Compose contract test**

Add `backend/tests/test_compose_x_sessions.py`:

```python
import json
import subprocess


def test_api_uses_persistent_feedgrab_session_directory():
    resolved = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        check=True,
        text=True,
        capture_output=True,
    )
    compose = json.loads(resolved.stdout)
    api = compose["services"]["api"]
    assert api["environment"]["FEEDGRAB_DATA_DIR"] == "/app/sessions"
    assert any(mount["target"] == "/app/sessions" for mount in api["volumes"])
    assert "sessions-data" in compose["volumes"]
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
conda run -n wems pytest backend/tests/test_compose_x_sessions.py -q
```

Expected: failure because `FEEDGRAB_DATA_DIR` and `sessions-data` are absent.

- [ ] **Step 3: Add the persistent session volume and build-context exclusion**

Add to the API service:

```yaml
environment:
  FEEDGRAB_DATA_DIR: /app/sessions
volumes:
  - uploads-data:/app/uploads
  - sessions-data:/app/sessions
```

Add `sessions-data:` under top-level volumes. Add `sessions` to `backend/.dockerignore` so host credentials cannot be copied into the image layer.

- [ ] **Step 4: Update operator documentation**

Document:

- UI-managed account creation and global rotation;
- external `feedgrab login twitter` sessions remain compatible and read-only in UI;
- local `FEEDGRAB_DATA_DIR` must be set before backend startup;
- Compose persists `/app/sessions`;
- feedgrab is an optional host/runtime integration and must be installed in the backend environment for actual X collection;
- no automatic X publishing.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
conda run -n wems pytest backend/tests -q
conda run -n wems python -m compileall -q backend
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
pnpm build
cd ..
docker compose config -q
git diff --check
git status --short
```

Expected:

- all backend tests pass;
- Python compilation exits 0;
- all frontend tests pass;
- TypeScript exits 0;
- Next.js production build exits 0;
- Compose configuration exits 0;
- no whitespace errors;
- only intended task files remain modified before commit.

- [ ] **Step 6: Commit the deployment/docs slice**

```bash
git add \
  docker-compose.yml backend/.dockerignore README.md \
  backend/tests/test_compose_x_sessions.py
git commit -m "docs(x): persist credential pool sessions"
```

- [ ] **Step 7: Record final X-pool evidence**

Run:

```bash
git log --oneline --decorate -8
git status --short
```

Record in the handoff:

- commit IDs from Tasks 1–6;
- managed/external account counts from a controlled run;
- first-account-429 to second-account rotation proof;
- full verification counts;
- whether a real X credential probe was run or remains intentionally unverified.

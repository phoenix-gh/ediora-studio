import os
import re
import json
import tempfile
import fcntl
import base64
import hashlib
from dataclasses import dataclass
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


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
QUARANTINED = re.compile(
    r"^\.x-credential-quarantine-(\d+)\.(active|disabled)\.json$"
)


@dataclass(frozen=True)
class CredentialPair:
    auth_token: str
    ct0: str


@dataclass(frozen=True)
class CredentialFileSnapshot:
    slot: int
    active: bytes | None
    disabled: bytes | None


@dataclass(frozen=True)
class CredentialFileQuarantine:
    snapshot: CredentialFileSnapshot
    path: Path
    was_enabled: bool


class CredentialFileError(RuntimeError):
    pass


def _session_fernet(key: str | bytes | None = None) -> Fernet:
    configured = key
    if configured is None:
        configured = os.getenv("X_SESSION_KEY", "").strip()
    if not configured:
        worker_token = os.getenv("WORKER_TOKEN", "").strip()
        if not worker_token:
            raise CredentialFileError(
                "X session 加密密钥未配置；请设置 X_SESSION_KEY"
            )
        configured = base64.urlsafe_b64encode(
            hashlib.sha256(worker_token.encode("utf-8")).digest()
        )
    if isinstance(configured, str):
        configured = configured.encode("ascii", "strict")
    try:
        return Fernet(configured)
    except (TypeError, ValueError) as exc:
        raise CredentialFileError("X session 加密密钥格式无效") from exc


class CredentialSessionVault:
    """Encrypt and decrypt managed X credentials for database persistence."""

    def __init__(self, key: str | bytes | None = None):
        self._fernet = _session_fernet(key)

    def encrypt(self, pair: CredentialPair) -> str:
        payload = json.dumps(
            {"auth_token": pair.auth_token, "ct0": pair.ct0},
            separators=(",", ":"),
        ).encode("utf-8")
        return self._fernet.encrypt(payload).decode("ascii")

    def decrypt(self, ciphertext: str) -> CredentialPair:
        try:
            payload = json.loads(self._fernet.decrypt(ciphertext.encode("ascii")))
            auth_token = payload["auth_token"]
            ct0 = payload["ct0"]
        except (InvalidToken, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
            raise CredentialFileError("X session 加密内容无效") from None
        if not isinstance(auth_token, str) or not isinstance(ct0, str):
            raise CredentialFileError("X session 加密内容无效")
        pair = CredentialPair(auth_token.strip(), ct0.strip())
        if not pair.auth_token or not pair.ct0:
            raise CredentialFileError("X session 加密内容无效")
        return pair


def _payload(pair: CredentialPair) -> bytes:
    return json.dumps(
        {"auth_token": pair.auth_token, "ct0": pair.ct0},
        separators=(",", ":"),
    ).encode()


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

    def acquire_lock(self):
        self._ensure_directory()
        path = self.directory / ".x-credential-pool.lock"
        handle = path.open("a+b")
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except Exception:
            handle.close()
            raise
        return handle

    @staticmethod
    def release_lock(handle) -> None:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def _atomic_write(self, path: Path, payload: bytes) -> None:
        self._ensure_directory()
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

    def _ensure_directory(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)

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
            if obsolete.exists():
                os.replace(obsolete, destination)
                os.chmod(destination, 0o600)
            self._atomic_write(destination, _payload(pair))
        except Exception:
            self.restore(previous)
            raise
        return previous

    def set_enabled(self, slot: int, enabled: bool) -> CredentialFileSnapshot:
        self._ensure_directory()
        previous = self.snapshot(slot)
        active, disabled = self._paths(slot)
        source, destination = (disabled, active) if enabled else (active, disabled)
        if not source.exists() or destination.exists():
            raise CredentialFileError("托管凭据文件状态冲突")
        os.replace(source, destination)
        os.chmod(destination, 0o600)
        return previous

    def delete(self, slot: int) -> CredentialFileSnapshot:
        self._ensure_directory()
        previous = self.snapshot(slot)
        active, disabled = self._paths(slot)
        try:
            if active.exists():
                os.replace(active, disabled)
                os.chmod(disabled, 0o600)
            disabled.unlink(missing_ok=True)
        except Exception:
            self.restore(previous)
            raise
        return previous

    def quarantine(self, slot: int) -> CredentialFileQuarantine:
        """Hide one managed credential without permanently deleting it."""
        self._ensure_directory()
        previous = self.snapshot(slot)
        active, disabled = self._paths(slot)
        existing = [path for path in (active, disabled) if path.exists()]
        if len(existing) != 1:
            raise CredentialFileError("托管凭据文件不存在或状态冲突")
        source = existing[0]
        was_enabled = source == active
        state = "active" if was_enabled else "disabled"
        destination = self.directory / (
            f".x-credential-quarantine-{slot}.{state}.json"
        )
        if destination.exists():
            raise CredentialFileError("托管凭据隔离文件状态冲突")
        os.replace(source, destination)
        os.chmod(destination, 0o600)
        return CredentialFileQuarantine(previous, destination, was_enabled)

    def restore_quarantine(self, quarantine: CredentialFileQuarantine) -> None:
        if not quarantine.path.exists():
            self.restore(quarantine.snapshot)
            return
        active, disabled = self._paths(quarantine.snapshot.slot)
        destination = active if quarantine.was_enabled else disabled
        if active.exists() or disabled.exists():
            raise CredentialFileError("托管凭据文件状态冲突")
        os.replace(quarantine.path, destination)
        os.chmod(destination, 0o600)

    def finalize_quarantine(self, quarantine: CredentialFileQuarantine) -> None:
        quarantine.path.unlink(missing_ok=True)

    def reconcile_quarantines(self, managed_slots: set[int]) -> list[str]:
        """Recover pre-commit deletes and finish post-commit deletes."""
        if not self.directory.exists():
            return []
        errors: list[str] = []
        for path in sorted(self.directory.iterdir()):
            match = QUARANTINED.match(path.name)
            if not match or not path.is_file():
                continue
            slot = int(match.group(1))
            if slot not in managed_slots:
                path.unlink(missing_ok=True)
                continue
            was_enabled = match.group(2) == "active"
            active, disabled = self._paths(slot)
            destination = active if was_enabled else disabled
            if active.exists() or disabled.exists():
                errors.append(f"账号凭据槽位 {slot} 的隔离文件状态冲突")
                continue
            os.replace(path, destination)
            os.chmod(destination, 0o600)
        return errors

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
            if not isinstance(value, dict):
                raise TypeError("credential file must contain an object")
            auth_token = value["auth_token"]
            ct0 = value["ct0"]
            if not isinstance(auth_token, str) or not isinstance(ct0, str):
                raise TypeError("credential fields must be strings")
            auth_token = auth_token.strip()
            ct0 = ct0.strip()
        except (OSError, json.JSONDecodeError, KeyError, AttributeError, TypeError) as exc:
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

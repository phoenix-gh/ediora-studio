import os
import re
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path


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

"""Safe CRUD endpoints for database-owned X credential accounts."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import XCredentialAccount
from x_credential_store import CredentialFileError, CredentialFileStore, CredentialPair


router = APIRouter(prefix="/x/accounts", tags=["x-accounts"])


class XCredentialAccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

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
    model_config = ConfigDict(extra="forbid")

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


async def _accounts(db: AsyncSession) -> list[XCredentialAccount]:
    return list((await db.execute(
        select(XCredentialAccount).order_by(XCredentialAccount.id)
    )).scalars())


async def _pool(db: AsyncSession, store: CredentialFileStore) -> XCredentialPoolOut:
    accounts = await _accounts(db)
    managed_slots = {account.credential_slot for account in accounts}
    return XCredentialPoolOut(
        accounts=[XCredentialAccountOut.model_validate(account) for account in accounts],
        external_sessions=store.external_sessions(managed_slots),
        managed_enabled=sum(account.enabled for account in accounts),
        total_accounts=len(accounts),
        available_accounts=sum(
            account.enabled and account.test_status != "failed" for account in accounts
        ),
    )


def _restore_after_commit_failure(store: CredentialFileStore, snapshot) -> None:
    if snapshot is not None:
        store.restore(snapshot)


@router.get("", response_model=XCredentialPoolOut)
async def list_x_accounts(db: AsyncSession = Depends(get_db)):
    return await _pool(db, CredentialFileStore())


@router.post("", response_model=XCredentialPoolOut)
async def create_x_account(
    body: XCredentialAccountCreate,
    db: AsyncSession = Depends(get_db),
):
    store = CredentialFileStore()
    reserved_slots = set((await db.execute(
        select(XCredentialAccount.credential_slot)
    )).scalars())
    slot = store.allocate_slot(reserved_slots)
    pair = CredentialPair(body.auth_token, body.ct0)
    account = XCredentialAccount(
        name=body.name,
        enabled=body.enabled,
        credential_slot=slot,
        auth_token_preview=credential_preview(pair.auth_token),
        ct0_preview=credential_preview(pair.ct0),
    )
    db.add(account)
    snapshot = None
    try:
        await db.flush()
        snapshot = store.write(slot, body.enabled, pair)
        await db.commit()
    except Exception:
        await db.rollback()
        _restore_after_commit_failure(store, snapshot)
        raise
    return await _pool(db, store)


@router.patch("/{account_id}", response_model=XCredentialPoolOut)
async def patch_x_account(
    account_id: int,
    body: XCredentialAccountPatch,
    db: AsyncSession = Depends(get_db),
):
    account = await db.get(XCredentialAccount, account_id)
    if account is None:
        raise HTTPException(404, "account not found")

    store = CredentialFileStore()
    replacing_credentials = bool((body.auth_token or "").strip())
    changing_enabled = body.enabled is not None and body.enabled != account.enabled
    next_enabled = body.enabled if body.enabled is not None else account.enabled
    snapshot = None
    try:
        if replacing_credentials:
            pair = CredentialPair(body.auth_token.strip(), body.ct0.strip())
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
        _restore_after_commit_failure(store, snapshot)
        raise
    return await _pool(db, store)


@router.delete("/{account_id}", response_model=XCredentialPoolOut)
async def delete_x_account(account_id: int, db: AsyncSession = Depends(get_db)):
    account = await db.get(XCredentialAccount, account_id)
    if account is None:
        raise HTTPException(404, "account not found")

    store = CredentialFileStore()
    snapshot = None
    try:
        snapshot = store.delete(account.credential_slot)
        await db.delete(account)
        await db.commit()
    except Exception:
        await db.rollback()
        _restore_after_commit_failure(store, snapshot)
        raise
    return await _pool(db, store)


async def reconcile_x_credential_accounts(
    db: AsyncSession,
    store: CredentialFileStore,
) -> list[str]:
    """Repair only DB-owned files and report inconsistent account records."""
    errors: list[str] = []
    snapshots = []
    for account in await _accounts(db):
        try:
            pair = store.read(account.credential_slot)
        except CredentialFileError as exc:
            account.test_status = "failed"
            account.last_test_error = str(exc)
            errors.append(f"账号 {account.id} 的凭据文件不存在或状态冲突")
            continue

        if (
            account.auth_token_preview
            and account.auth_token_preview != credential_preview(pair.auth_token)
        ) or (
            account.ct0_preview and account.ct0_preview != credential_preview(pair.ct0)
        ):
            account.test_status = "failed"
            account.last_test_error = "凭据文件与账号预览不匹配"
            errors.append(f"账号 {account.id} 的凭据文件冲突")
            continue

        previous = store.snapshot(account.credential_slot)
        current_enabled = previous.active is not None
        if current_enabled != account.enabled:
            try:
                snapshots.append(store.set_enabled(account.credential_slot, account.enabled))
            except CredentialFileError:
                account.test_status = "failed"
                account.last_test_error = "凭据文件状态冲突"
                errors.append(f"账号 {account.id} 的凭据文件状态冲突")

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        for snapshot in reversed(snapshots):
            store.restore(snapshot)
        raise
    return errors

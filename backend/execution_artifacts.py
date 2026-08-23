"""Append-only persistence operations for durable Job execution artifacts."""

from __future__ import annotations

import hashlib
import json
from typing import Literal, Sequence

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from models import ContentJob, ContentJobStep, ExecutionArtifact


class ExecutionArtifactError(ValueError):
    pass


ArtifactRole = Literal["primary", "auxiliary"]


def _canonical_digest(
    *,
    kind: str,
    role: ArtifactRole,
    title: str,
    text_content: str | None,
    structured_content: object | None,
) -> str:
    payload = {
        "kind": kind,
        "role": role,
        "title": title,
        "text_content": text_content,
        "structured_content": structured_content,
    }
    try:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as error:
        raise ExecutionArtifactError(
            "structured_content must be JSON serializable"
        ) from error
    return hashlib.sha256(encoded).hexdigest()


def _validate_content(
    *,
    kind: str,
    role: str,
    title: str,
    text_content: str | None,
    structured_content: object | None,
) -> tuple[str, ArtifactRole, str, str | None]:
    if not isinstance(kind, str) or not kind.strip():
        raise ExecutionArtifactError("kind must not be blank")
    if role not in {"primary", "auxiliary"}:
        raise ExecutionArtifactError("role must be primary or auxiliary")
    if not isinstance(title, str) or not title.strip():
        raise ExecutionArtifactError("title must not be blank")
    if text_content is not None and not isinstance(text_content, str):
        raise ExecutionArtifactError("text_content must be a string or null")
    if not (text_content and text_content.strip()) and structured_content is None:
        raise ExecutionArtifactError(
            "artifact must contain text_content or structured_content"
        )
    return kind.strip(), role, title.strip(), text_content


async def append_execution_artifact(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
    kind: str,
    role: ArtifactRole,
    title: str,
    text_content: str | None = None,
    structured_content: object | None = None,
) -> ExecutionArtifact:
    """Append one validated artifact without committing the caller's transaction."""
    if attempt <= 0:
        raise ExecutionArtifactError("attempt must be positive")
    normalized_kind, normalized_role, normalized_title, normalized_text = _validate_content(
        kind=kind,
        role=role,
        title=title,
        text_content=text_content,
        structured_content=structured_content,
    )
    digest = _canonical_digest(
        kind=normalized_kind,
        role=normalized_role,
        title=normalized_title,
        text_content=normalized_text,
        structured_content=structured_content,
    )

    if await session.get(ContentJob, job_id) is None:
        raise ExecutionArtifactError(f"job {job_id} not found")
    step = await session.scalar(
        select(ContentJobStep)
        .where(ContentJobStep.id == step_id)
        .with_for_update()
    )
    if step is None:
        raise ExecutionArtifactError(f"job step {step_id} not found")
    if step.job_id != job_id:
        raise ExecutionArtifactError(
            f"step {step_id} belongs to job {step.job_id}"
        )
    if step.attempt != attempt:
        raise ExecutionArtifactError(
            f"step {step_id} belongs to attempt {step.attempt}, not {attempt}"
        )

    existing_primary = await session.scalar(
        select(ExecutionArtifact.id).where(
            ExecutionArtifact.job_id == job_id,
            ExecutionArtifact.step_id == step_id,
            ExecutionArtifact.attempt == attempt,
            ExecutionArtifact.role == "primary",
        )
    )
    if existing_primary is not None and normalized_role == "primary":
        raise ExecutionArtifactError(
            f"primary artifact already exists for step {step_id} attempt {attempt}"
        )

    artifact = ExecutionArtifact(
        job_id=job_id,
        step_id=step_id,
        attempt=attempt,
        kind=normalized_kind,
        role=normalized_role,
        title=normalized_title,
        text_content=normalized_text,
        structured_content=structured_content,
        digest=digest,
    )
    try:
        async with session.begin_nested():
            session.add(artifact)
            await session.flush()
    except IntegrityError as error:
        raise ExecutionArtifactError(
            f"primary artifact already exists for step {step_id} attempt {attempt}"
        ) from error
    return artifact


async def list_execution_artifacts(
    session: AsyncSession,
    *,
    job_id: int,
    include_superseded: bool = True,
) -> list[ExecutionArtifact]:
    statement = select(ExecutionArtifact).where(
        ExecutionArtifact.job_id == job_id,
    )
    if not include_superseded:
        statement = statement.where(ExecutionArtifact.status == "active")
    return list((await session.execute(
        statement.order_by(ExecutionArtifact.id.asc())
    )).scalars().all())


async def supersede_execution_artifacts(
    session: AsyncSession,
    *,
    job_id: int,
    step_ids: Sequence[int],
) -> int:
    normalized_step_ids = sorted({step_id for step_id in step_ids})
    if not normalized_step_ids:
        return 0
    result = await session.execute(
        update(ExecutionArtifact)
        .where(
            ExecutionArtifact.job_id == job_id,
            ExecutionArtifact.step_id.in_(normalized_step_ids),
            ExecutionArtifact.status == "active",
        )
        .values(status="superseded")
    )
    return result.rowcount or 0

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ChatMessage, ChatSession, WritingPlan, now_utc


router = APIRouter(prefix="/chat", tags=["chat"])


class SkillRunStepAudit(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    status: Literal["pending", "completed", "failed", "skipped"]
    evidence: list[str] = Field(default_factory=list, max_length=32)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_evidence(self):
        if any(len(item) > 500 for item in self.evidence):
            raise ValueError("Skill run evidence is too large")
        return self


class SkillToolEvidenceAudit(BaseModel):
    toolName: str = Field(min_length=1, max_length=200)
    toolCallId: str = Field(min_length=1, max_length=200)
    state: Literal["succeeded", "failed", "approval-pending"]

    model_config = ConfigDict(extra="forbid")


class SkillRunViolationAudit(BaseModel):
    requirement: str = Field(min_length=1, max_length=500)
    evidence: str = Field(min_length=1, max_length=500)
    correction: str = Field(min_length=1, max_length=500)

    model_config = ConfigDict(extra="forbid")


class SkillRunValidationAudit(BaseModel):
    passed: bool
    violations: list[SkillRunViolationAudit] = Field(default_factory=list, max_length=24)

    model_config = ConfigDict(extra="forbid")


class SkillRunAudit(BaseModel):
    skillName: str = Field(min_length=1, max_length=80)
    activation: Literal["manual", "automatic", "restored"]
    steps: list[SkillRunStepAudit] = Field(default_factory=list, max_length=12)
    loadedReferences: list[str] = Field(default_factory=list, max_length=24)
    toolEvidence: list[SkillToolEvidenceAudit] = Field(default_factory=list, max_length=24)
    validation: SkillRunValidationAudit
    revisionCount: Literal[0, 1]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_reference_paths(self):
        if any(len(path) > 500 for path in self.loadedReferences):
            raise ValueError("Skill run reference path is too large")
        return self


class CapabilityReferenceSnapshot(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    bytes: int = Field(ge=0, le=10 * 1024 * 1024)
    loaded: bool
    contentDigest: str | None = Field(default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")

    model_config = ConfigDict(extra="forbid")


class SkillCapabilitySnapshot(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    version: str = Field(max_length=120)
    source: Literal["builtin", "uploaded"]
    activation: Literal["manual", "automatic", "restored"]
    instructionsDigest: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    references: list[CapabilityReferenceSnapshot] = Field(default_factory=list, max_length=200)

    model_config = ConfigDict(extra="forbid")


class ToolCapabilityDescriptor(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2_000)
    inputSchemaDigest: str | None = Field(default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    sideEffecting: bool
    needsApproval: bool
    replayPolicy: Literal["replayable", "uncertain-on-interruption"]
    concurrencyPolicy: Literal["parallel-safe", "serialized", "unknown"] = "unknown"
    idempotencyPolicy: Literal["replayable", "claim-backed", "unknown"] = "unknown"

    model_config = ConfigDict(extra="forbid")


class CapabilityPolicySnapshot(BaseModel):
    approvalPolicy: Literal["interactive", "automatic"]
    allowedToolNames: list[str] | None = Field(default=None, max_length=256)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_allowed_tool_names(self):
        if self.allowedToolNames is not None and any(
            not 0 < len(name) <= 200 for name in self.allowedToolNames
        ):
            raise ValueError("Capability tool name is too large or blank")
        return self


class AgentCapabilitySnapshot(BaseModel):
    schemaVersion: Literal[1]
    mode: Literal["chat", "job"]
    skill: SkillCapabilitySnapshot | None = None
    tools: list[ToolCapabilityDescriptor] = Field(default_factory=list, max_length=256)
    policy: CapabilityPolicySnapshot

    model_config = ConfigDict(extra="forbid")


class ChatMessageOut(BaseModel):
    id: int
    role: Literal["user", "assistant", "tool"]
    parts: list[dict]
    text: str
    skill_run: SkillRunAudit | None = None
    capability_snapshot: AgentCapabilitySnapshot | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ChatSessionOut(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ChatSessionDetail(ChatSessionOut):
    messages: list[ChatMessageOut]


class ChatSessionCreate(BaseModel):
    title: str = "新对话"


class ChatSessionTitleUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ChatMessageCreate(BaseModel):
    role: Literal["user", "assistant", "tool"]
    parts: list[dict] = Field(default_factory=list)
    text: str = ""
    skill_run: SkillRunAudit | None = None
    capability_snapshot: AgentCapabilitySnapshot | None = None


class ChatMessagePartsUpdate(BaseModel):
    parts: list[dict] = Field(default_factory=list)


class SourceSearchResult(BaseModel):
    source: Literal["writing_plan"]
    id: int
    title: str
    summary: str
    url: str
    published_at: datetime | None


class SourceReadResult(SourceSearchResult):
    found: Literal[True] = True
    content: str


class SourceNotFound(BaseModel):
    source: str
    id: int
    found: Literal[False] = False


def _summary(text: str, max_length: int = 500) -> str:
    normalized = " ".join(text.split())
    return normalized[:max_length]


def _matches_keywords(text: str, keywords: list[str]) -> bool:
    normalized = text.lower()
    return any(keyword in normalized for keyword in keywords)


def _writing_plan_content(plan: WritingPlan) -> str:
    return "\n\n".join(part for part in (plan.strategy, plan.description) if part)


def _writing_plan_result(plan: WritingPlan) -> SourceSearchResult:
    return SourceSearchResult(
        source="writing_plan",
        id=plan.id,
        title=plan.title,
        summary=_summary(_writing_plan_content(plan)),
        url="",
        published_at=plan.updated_at,
    )


@router.get("/sessions", response_model=list[ChatSessionOut])
async def list_sessions(db: AsyncSession = Depends(get_db)):
    return (await db.execute(
        select(ChatSession).order_by(desc(ChatSession.updated_at), desc(ChatSession.id))
    )).scalars().all()


@router.post("/sessions", response_model=ChatSessionOut, status_code=201)
async def create_session(body: ChatSessionCreate, db: AsyncSession = Depends(get_db)):
    session = ChatSession(title=body.title.strip() or "新对话")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("/sessions/{session_id}", response_model=ChatSessionDetail, response_model_exclude_none=True)
async def get_session(session_id: int, db: AsyncSession = Depends(get_db)):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    messages = (await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at, ChatMessage.id)
    )).scalars().all()
    return ChatSessionDetail(
        id=session.id,
        title=session.title,
        created_at=session.created_at,
        updated_at=session.updated_at,
        messages=messages,
    )


@router.patch("/sessions/{session_id}", response_model=ChatSessionOut)
async def rename_session(session_id: int, body: ChatSessionTitleUpdate, db: AsyncSession = Depends(get_db)):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    session.title = body.title.strip() or "新对话"
    session.updated_at = now_utc()
    await db.commit()
    await db.refresh(session)
    return session


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: int, db: AsyncSession = Depends(get_db)):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
    await db.delete(session)
    await db.commit()


@router.post("/sessions/{session_id}/messages", response_model=ChatMessageOut, status_code=201, response_model_exclude_none=True)
async def append_message(
    session_id: int,
    body: ChatMessageCreate,
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    message = ChatMessage(session_id=session_id, **body.model_dump())
    session.updated_at = now_utc()
    db.add(message)
    await db.commit()
    await db.refresh(message)
    return message


@router.patch("/sessions/{session_id}/messages/{message_id}", response_model=ChatMessageOut)
async def replace_message_parts(
    session_id: int,
    message_id: int,
    body: ChatMessagePartsUpdate,
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    message = await db.get(ChatMessage, message_id)
    if not message or message.session_id != session_id:
        raise HTTPException(404, "会话消息不存在")
    message.parts = body.parts
    session.updated_at = now_utc()
    await db.commit()
    await db.refresh(message)
    return message


@router.get("/sources/search", response_model=list[SourceSearchResult])
async def search_sources(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
):
    keywords = [keyword.lower() for keyword in q.replace(",", " ").split() if keyword]
    if not keywords:
        return []

    plans = (await db.execute(
        select(WritingPlan)
        .where(WritingPlan.status == "active")
        .order_by(desc(WritingPlan.updated_at), desc(WritingPlan.id))
        .limit(200)
    )).scalars().all()
    results = [
        _writing_plan_result(plan)
        for plan in plans
        if _matches_keywords(f"{plan.title} {plan.strategy} {plan.description}", keywords)
    ][:limit]

    return results[:limit]


@router.get("/sources/{source}/{source_id}", response_model=SourceReadResult | SourceNotFound)
async def read_source(
    source: str,
    source_id: int,
    db: AsyncSession = Depends(get_db),
):
    if source == "writing_plan":
        plan = await db.get(WritingPlan, source_id)
        if plan:
            result = _writing_plan_result(plan)
            return SourceReadResult(**result.model_dump(), content=_writing_plan_content(plan))
    return SourceNotFound(source=source, id=source_id)

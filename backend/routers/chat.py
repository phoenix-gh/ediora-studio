from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import ChatMessage, ChatSession, now_utc


router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessageOut(BaseModel):
    id: int
    role: Literal["user", "assistant", "tool"]
    parts: list[dict]
    text: str
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


class ChatMessageCreate(BaseModel):
    role: Literal["user", "assistant", "tool"]
    parts: list[dict] = Field(default_factory=list)
    text: str = ""


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


@router.get("/sessions/{session_id}", response_model=ChatSessionDetail)
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


@router.post("/sessions/{session_id}/messages", response_model=ChatMessageOut, status_code=201)
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

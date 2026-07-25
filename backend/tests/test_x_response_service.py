import asyncio
import sys

import pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("WMS_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'responses.db'}")
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    for name in list(sys.modules):
        if name.startswith(("database", "models", "x_response_service")):
            sys.modules.pop(name, None)

    from database import Base, SessionLocal, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    return SessionLocal


def test_unverified_translation_is_downgraded():
    from x_response_service import normalize_decision

    result = normalize_decision({
        "action": "translate_quote",
        "score": 91,
        "confidence": 0.92,
        "reason": "重大更新",
        "summary_cn": "官方发布新 API",
        "comment_draft": None,
        "quote_draft": "官方发布了新 API",
        "claims": [],
    }, "unverified")

    assert result["action"] == "watch"
    assert result["quote_draft"] is None
    assert result["notification_tier"] == "digest"


@pytest.mark.parametrize(
    ("score", "confidence", "verification_status", "want"),
    [
        (75, 0.70, "verified", "immediate"),
        (75, 0.69, "verified", "digest"),
        (50, 0.90, "not_required", "digest"),
        (49, 0.99, "verified", "silent"),
    ],
)
def test_notification_tier_boundaries(score, confidence, verification_status, want):
    from x_response_service import notification_tier

    assert notification_tier(score, confidence, verification_status) == want


def test_watch_and_ignore_never_keep_publishable_drafts():
    from x_response_service import normalize_decision

    for action in ("watch", "ignore"):
        result = normalize_decision({
            "action": action,
            "score": 20,
            "confidence": 0.8,
            "reason": "不需要响应",
            "summary_cn": "普通营销消息",
            "comment_draft": "这不该保留",
            "quote_draft": "这也不该保留",
            "claims": [],
        }, "not_required")
        assert result["comment_draft"] is None
        assert result["quote_draft"] is None


def test_persist_decision_is_idempotent_per_tweet(env):
    from models import XPost, XResponseDecision, XSubscription
    from x_response_service import persist_decision
    from datetime import datetime, timezone

    async def run():
        async with env() as db:
            sub = XSubscription(url="https://x.com/openai", label="OpenAI")
            db.add(sub)
            await db.commit()
            await db.refresh(sub)
            db.add(XPost(
                tweet_id="t1",
                subscription_id=sub.id,
                username="OpenAI",
                content="New API",
                url="https://x.com/OpenAI/status/t1",
                published_at=datetime.now(timezone.utc),
            ))
            await db.commit()

            raw = {
                "action": "comment",
                "score": 80,
                "confidence": 0.8,
                "reason": "可补充观点",
                "summary_cn": "OpenAI 发布新 API",
                "comment_draft": "这个 API 最值得关注的是工具调用边界。",
                "quote_draft": None,
                "claims": [],
            }
            first = await persist_decision(
                db, "t1", raw,
                {"verification_status": "not_required", "model_provider": "openai",
                 "model_name": "gpt-test", "prompt_version": "test-v1"},
            )
            second = await persist_decision(
                db, "t1", {**raw, "score": 99},
                {"verification_status": "not_required"},
            )
            rows = (await db.execute(
                __import__("sqlalchemy").select(XResponseDecision)
            )).scalars().all()
            return first, second, rows

    first, second, rows = asyncio.run(run())
    assert first.id == second.id
    assert len(rows) == 1
    assert rows[0].score == 80
    assert rows[0].telegram_status == "pending"

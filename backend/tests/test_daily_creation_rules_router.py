import asyncio
import sys

import pytest
from fastapi.testclient import TestClient


TOKEN = "daily-creation-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "WMS_DATABASE_URL",
        f"sqlite+aiosqlite:///{tmp_path / 'daily-creation-router.db'}",
    )
    monkeypatch.setenv("WMS_DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("WMS_WORKER_TOKEN", TOKEN)
    for module_name in list(sys.modules):
        if module_name.startswith((
            "database", "models", "main", "routers", "config", "schemas",
            "mcp_server", "daily_planner", "daily_creation_service",
            "content_jobs", "job_queue", "scheduler",
        )):
            sys.modules.pop(module_name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(setup())
    from main import app
    with TestClient(app) as test_client:
        yield test_client
    asyncio.run(engine.dispose())


def seed_source(*, with_account=False):
    from database import SessionLocal
    from models import CreativeAsset, CreativeAssetDirectory, PublishAccount

    async def seed():
        async with SessionLocal() as session:
            session.add(CreativeAssetDirectory(name="产品实验", asset_type="article"))
            session.add(CreativeAssetDirectory(name="增长资料", asset_type="article"))
            session.add(CreativeAssetDirectory(name="媒体素材", asset_type="media"))
            asset = CreativeAsset(
                asset_type="article", directory="产品实验", title="验证需求",
                content="先确认真实付费，再扩大投入。",
            )
            session.add(asset)
            if with_account:
                session.add(PublishAccount(id="x-main", name="主账号", platform="x"))
            await session.commit()
            await session.refresh(asset)
            return asset.id

    return asyncio.run(seed())


def recurring_payload(**overrides):
    payload = {
        "name": "产品短帖",
        "asset_type": "article",
        "directory": "产品实验",
        "output_type": "x_short_post",
        "target_count": 3,
        "execution_mode": "recurring",
        "scheduled_time": "09:30",
        "timezone": "Asia/Shanghai",
        "lookback_days": 5,
        "delivery_mode": "drafts",
        "account_id": None,
        "instructions": "保持具体",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


def test_rule_crud_validates_conditional_fields_and_preserves_history(client):
    seed_source(with_account=True)
    created = client.post(
        "/api/daily-plan/creation-rules",
        json=recurring_payload(account_id="x-main"),
    )
    assert created.status_code == 201, created.text
    rule = created.json()
    assert rule["directory"] == "产品实验"
    assert rule["enabled"] is True

    assert client.post(
        "/api/daily-plan/creation-rules",
        json=recurring_payload(directory="不存在"),
    ).status_code == 400
    assert client.post(
        "/api/daily-plan/creation-rules",
        json=recurring_payload(target_count=0),
    ).status_code == 422
    assert client.post(
        "/api/daily-plan/creation-rules",
        json=recurring_payload(execution_mode="once"),
    ).status_code == 422

    updated = client.patch(
        f"/api/daily-plan/creation-rules/{rule['id']}",
        json={"enabled": False, "target_count": 4},
    )
    assert updated.status_code == 200
    assert updated.json()["enabled"] is False
    assert updated.json()["target_count"] == 4

    deleted = client.delete(f"/api/daily-plan/creation-rules/{rule['id']}")
    assert deleted.status_code == 204
    assert client.get("/api/daily-plan/creation-rules").json() == []
    assert client.get(
        f"/api/daily-plan/creation-runs?rule_id={rule['id']}"
    ).status_code == 200


def test_rule_accepts_multiple_same_type_directories_and_mirrors_legacy_field(client):
    seed_source()
    created = client.post(
        "/api/daily-plan/creation-rules",
        json=recurring_payload(
            directories=[" 产品实验 ", "增长资料", "产品实验"],
        ),
    )

    assert created.status_code == 201, created.text
    assert created.json()["directories"] == ["产品实验", "增长资料"]
    assert created.json()["directory"] == "产品实验"
    rejected = client.patch(
        f"/api/daily-plan/creation-rules/{created.json()['id']}",
        json={"asset_type": "media"},
    )
    assert rejected.status_code == 400
    assert "产品实验" in rejected.text


def test_run_now_is_idempotent_and_creates_daily_creation_job(client, monkeypatch):
    seed_source()
    enqueued = []

    async def fake_enqueue(job_id):
        enqueued.append(job_id)

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post(
        "/api/daily-plan/creation-rules", json=recurring_payload()
    ).json()

    first = client.post(f"/api/daily-plan/creation-rules/{rule['id']}/run")
    second = client.post(f"/api/daily-plan/creation-rules/{rule['id']}/run")

    assert first.status_code == 202, first.text
    assert second.status_code == 202, second.text
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["status"] == "queued"
    assert len(enqueued) == 1

    from database import SessionLocal
    from models import ContentJob, DailyCreationRun

    async def verify():
        async with SessionLocal() as session:
            run = await session.get(DailyCreationRun, first.json()["id"])
            job = await session.get(ContentJob, run.content_job_id)
            return run, job

    creation_run, job = asyncio.run(verify())
    assert job.flow == "daily_creation"
    assert job.input_data == {"run_id": creation_run.id}
    assert creation_run.rule_snapshot["directory"] == "产品实验"
    assert creation_run.rule_snapshot["directories"] == ["产品实验"]


def test_worker_context_output_and_completion_require_token(client, monkeypatch):
    asset_id = seed_source()

    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post(
        "/api/daily-plan/creation-rules", json=recurring_payload(target_count=1)
    ).json()
    creation_run = client.post(
        f"/api/daily-plan/creation-rules/{rule['id']}/run"
    ).json()
    base = f"/api/daily-plan/creation-runs/{creation_run['id']}"
    assert client.get(f"{base}/context").status_code == 403

    headers = {"X-WMS-Worker-Token": TOKEN}
    context = client.get(f"{base}/context", headers=headers)
    assert context.status_code == 200
    assert context.json()["rule"]["directory"] == "产品实验"
    assert context.json()["rule"]["directories"] == ["产品实验"]
    assert "先确认真实付费，再扩大投入。" not in context.text

    persisted = client.post(f"{base}/outputs", headers=headers, json={
        "asset_id": asset_id,
        "title": "先卖再做",
        "text": "真实付费比口头认可更可靠。",
        "topic": "需求验证",
        "angle": "真实付费",
        "reuse_decision": "fresh",
        "reuse_explanation": "",
    })
    assert persisted.status_code == 201, persisted.text
    assert persisted.json()["output_kind"] == "draft"
    assert persisted.json()["draft_id"] is not None

    completed = client.post(f"{base}/complete", headers=headers, json={
        "status": "succeeded", "created_count": 1,
        "detail": {"excluded": []},
    })
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"
    assert completed.json()["created_count"] == 1
    assert completed.json()["detail"]["outputs"] == [{
        "output_kind": "draft",
        "output_id": persisted.json()["output_id"],
        "draft_id": persisted.json()["draft_id"],
        "plan_item_id": None,
    }]


def test_planner_replacement_preserves_creation_rule_items(client):
    from database import SessionLocal
    from models import DailyPlan, DailyPlanItem, PublishAccount

    async def seed():
        async with SessionLocal() as session:
            session.add(PublishAccount(id="x-main", name="主账号", platform="x"))
            plan = DailyPlan(plan_date="2026-08-04", status="ready")
            session.add(plan)
            await session.flush()
            session.add_all([
                DailyPlanItem(
                    plan_id=plan.id, account_id="x-main", title="旧策划项",
                    origin="planner",
                ),
                DailyPlanItem(
                    plan_id=plan.id, account_id="x-main", title="规则生成项",
                    origin="creation_rule", creation_run_id=77,
                ),
            ])
            await session.commit()
            return plan.id

    plan_id = asyncio.run(seed())
    response = client.post(f"/api/daily-plan/{plan_id}/items", json={
        "items": [{
            "account_id": "x-main", "title": "新策划项",
            "content_type": "short",
        }],
        "note": "替换总编建议",
    })

    assert response.status_code == 200
    titles = {item["title"] for item in response.json()["items"]}
    assert titles == {"新策划项", "规则生成项"}

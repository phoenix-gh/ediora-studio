import asyncio
import sys
from datetime import datetime, time, timedelta, timezone

import pytest
from fastapi.testclient import TestClient


TOKEN = "daily-creation-worker-token-at-least-32-chars"


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv("WMS_WORKER_TOKEN", TOKEN)
    for module_name in list(sys.modules):
        if module_name.startswith((
            "database", "models", "main", "routers", "config", "schemas",
            "mcp_server", "daily_creation_scheduler", "daily_creation_service",
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
        "prompt": "研究今天的新素材，把值得发布的内容保存到草稿箱。",
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


def prompt_rule_payload(**overrides):
    payload = {
        "name": "通用 Agent 日报",
        "prompt": "研究今天的新素材，把值得发布的内容保存到草稿箱。",
        "execution_mode": "recurring",
        "scheduled_time": "09:00",
        "timezone": "Asia/Shanghai",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


def test_prompt_first_rule_does_not_require_asset_directory(client):
    response = client.post("/api/creation-rules", json=prompt_rule_payload())

    assert response.status_code == 201, response.text
    assert response.json()["prompt"] == prompt_rule_payload()["prompt"]
    assert response.json()["directories"] == []


def test_prompt_first_rule_accepts_explicit_empty_directory(client):
    response = client.post(
        "/api/creation-rules",
        json=prompt_rule_payload(directory="", directories=[]),
    )

    assert response.status_code == 201, response.text
    assert response.json()["directory"] == ""
    assert response.json()["directories"] == []

    updated = client.patch(
        f"/api/creation-rules/{response.json()['id']}",
        json={"directory": "", "directories": []},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["directory"] == ""
    assert updated.json()["directories"] == []


def test_creation_rule_rejects_blank_prompt(client):
    response = client.post(
        "/api/creation-rules", json=prompt_rule_payload(prompt="   "),
    )

    assert response.status_code == 422
    assert any(
        detail["loc"][-1] == "prompt" for detail in response.json()["detail"]
    )


def test_rule_crud_validates_conditional_fields_and_preserves_history(client):
    seed_source(with_account=True)
    created = client.post(
        "/api/creation-rules",
        json=recurring_payload(account_id="x-main"),
    )
    assert created.status_code == 201, created.text
    rule = created.json()
    assert rule["directory"] == "产品实验"
    assert rule["enabled"] is True
    assert rule["skill_mode"] == "auto"
    assert rule["skill_name"] is None

    assert client.post(
        "/api/creation-rules",
        json=recurring_payload(directory="不存在"),
    ).status_code == 400
    assert client.post(
        "/api/creation-rules",
        json=recurring_payload(target_count=0),
    ).status_code == 422
    assert client.post(
        "/api/creation-rules",
        json=recurring_payload(execution_mode="once"),
    ).status_code == 422

    updated = client.patch(
        f"/api/creation-rules/{rule['id']}",
        json={"enabled": False, "target_count": 4},
    )
    assert updated.status_code == 200
    assert updated.json()["enabled"] is False
    assert updated.json()["target_count"] == 4

    deleted = client.delete(f"/api/creation-rules/{rule['id']}")
    assert deleted.status_code == 204
    assert client.get("/api/creation-rules").json() == []
    assert client.get(
        f"/api/creation-rules/runs?rule_id={rule['id']}"
    ).status_code == 200


def test_rule_list_includes_last_and_next_execution_times(client):
    seed_source()
    created = client.post(
        "/api/creation-rules",
        json=recurring_payload(scheduled_time="09:30"),
    )
    assert created.status_code == 201

    listed = client.get("/api/creation-rules")

    assert listed.status_code == 200
    rule = listed.json()[0]
    assert rule["last_run_at"] is None
    assert rule["next_run_at"] is not None

    disabled = client.patch(f"/api/creation-rules/{rule['id']}", json={"enabled": False})
    assert disabled.status_code == 200
    assert disabled.json()["next_run_at"] is None


def test_legacy_daily_plan_routes_are_not_registered(client):
    assert client.get("/api/daily-plan/today").status_code == 404


def test_rule_manual_skill_round_trips_and_auto_mode_clears_name(client):
    seed_source()
    missing = client.post(
        "/api/creation-rules",
        json=recurring_payload(skill_mode="manual", skill_name=None),
    )
    assert missing.status_code == 422

    created = client.post(
        "/api/creation-rules",
        json=recurring_payload(
            skill_mode="manual", skill_name="human-social-copy",
        ),
    )
    assert created.status_code == 201, created.text
    assert created.json()["skill_mode"] == "manual"
    assert created.json()["skill_name"] == "human-social-copy"

    automatic = client.patch(
        f"/api/creation-rules/{created.json()['id']}",
        json={"skill_mode": "auto"},
    )
    assert automatic.status_code == 200, automatic.text
    assert automatic.json()["skill_mode"] == "auto"
    assert automatic.json()["skill_name"] is None


def test_rule_accepts_multiple_same_type_directories_and_mirrors_legacy_field(client):
    seed_source()
    created = client.post(
        "/api/creation-rules",
        json=recurring_payload(
            directories=[" 产品实验 ", "增长资料", "产品实验"],
        ),
    )

    assert created.status_code == 201, created.text
    assert created.json()["directories"] == ["产品实验", "增长资料"]
    assert created.json()["directory"] == "产品实验"
    rejected = client.patch(
        f"/api/creation-rules/{created.json()['id']}",
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
        "/api/creation-rules", json=recurring_payload()
    ).json()

    first = client.post(f"/api/creation-rules/{rule['id']}/run")
    second = client.post(f"/api/creation-rules/{rule['id']}/run")

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
    updated = client.patch(
        f"/api/creation-rules/{rule['id']}",
        json={"prompt": "改成明天的新任务。"},
    )
    assert updated.status_code == 200, updated.text
    assert creation_run.rule_snapshot["prompt"] == recurring_payload()["prompt"]


def test_creation_run_projects_bounded_agent_audit_without_tool_payloads(
    client, monkeypatch,
):
    seed_source()
    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post(
        "/api/creation-rules",
        json=recurring_payload(skill_mode="manual", skill_name="human-social-copy"),
    ).json()
    creation_run = client.post(
        f"/api/creation-rules/{rule['id']}/run"
    ).json()

    from database import SessionLocal
    from models import AgentExecution, AgentToolCall, DailyCreationRun

    async def seed_audit():
        async with SessionLocal() as session:
            run = await session.get(DailyCreationRun, creation_run["id"])
            run.detail = {
                "self_validation": {"passed": True, "summary": "checked"},
            }
            execution = AgentExecution(
                job_id=run.content_job_id,
                status="succeeded",
                objective="must never be exposed",
                skill_mode="manual",
                skill_name="human-social-copy",
                skill_activation="automatic",
                phase="complete",
                audit_data={
                    "skillRun": {
                        "skillName": "human-social-copy",
                        "activation": "automatic",
                        "loadedReferences": ["references/finance-writing.md"],
                    },
                },
                completion_evidence={
                    "kind": "agent_run",
                    "executionId": 91,
                    "finalText": "已保存草稿并记录素材使用。",
                    "toolCallCount": 2,
                },
            )
            session.add(execution)
            await session.flush()
            session.add_all([
                AgentToolCall(
                    execution_id=execution.id, tool_call_id="save-1",
                    tool_name="save_draft", status="succeeded",
                    auto_approved=True, side_effecting=True,
                    input_summary={"secret": "not exposed"},
                    output_data={"secret": "not exposed"},
                ),
                AgentToolCall(
                    execution_id=execution.id, tool_call_id="publish-uncertain",
                    tool_name="save_external_item", status="uncertain",
                    auto_approved=True, side_effecting=True,
                    input_summary={"token": "not exposed"},
                    error="x" * 800,
                ),
            ])
            await session.commit()

    asyncio.run(seed_audit())
    response = client.get(
        f"/api/creation-rules/runs/{creation_run['id']}"
    )

    assert response.status_code == 200, response.text
    audit = response.json()["agent_execution"]
    assert audit["skill_name"] == "human-social-copy"
    assert audit["skill_activation"] == "automatic"
    assert audit["loaded_references"] == [{
        "path": "references/finance-writing.md", "bytes": 0,
    }]
    assert audit["self_validation"]["passed"] is True
    assert audit["completion"] == {
        "kind": "agent_run",
        "executionId": 91,
        "finalText": "已保存草稿并记录素材使用。",
        "toolCallCount": 2,
    }
    assert audit["tools"][0]["tool_name"] == "save_draft"
    assert audit["tools"][0]["auto_approved"] is True
    assert len(audit["tools"][1]["error"]) == 500
    assert "input_summary" not in response.text
    assert "not exposed" not in response.text


def test_bounded_completion_keeps_legacy_daily_batch_evidence():
    from routers.creation_rules import _bounded_completion

    assert _bounded_completion({
        "toolName": "save_daily_creation_outputs",
        "createdCount": 1,
        "outputIds": [192],
        "discarded": "not exposed",
    }) == {
        "toolName": "save_daily_creation_outputs",
        "createdCount": 1,
        "outputIds": [192],
    }


def test_creation_run_agent_log_exposes_redacted_message_timeline(
    client, monkeypatch,
):
    seed_source()

    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post("/api/creation-rules", json=recurring_payload()).json()
    creation_run = client.post(
        f"/api/creation-rules/{rule['id']}/run"
    ).json()

    from database import SessionLocal
    from models import AgentExecution, AgentMessageLog, DailyCreationRun

    async def seed_messages():
        async with SessionLocal() as session:
            run = await session.get(DailyCreationRun, creation_run["id"])
            execution = AgentExecution(
                job_id=run.content_job_id,
                status="succeeded",
                objective="create posts",
                skill_mode="auto",
                phase="complete",
            )
            session.add(execution)
            await session.flush()
            session.add_all([
                AgentMessageLog(
                    execution_id=execution.id,
                    phase="execute",
                    direction="model_request",
                    payload_data={"messages": [{"role": "user", "content": "auth_token=secret"}]},
                ),
                AgentMessageLog(
                    execution_id=execution.id,
                    phase="execute",
                    direction="model_response",
                    payload_data={"text": "done"},
                ),
            ])
            await session.commit()

    asyncio.run(seed_messages())
    response = client.get(
        f"/api/creation-rules/runs/{creation_run['id']}/agent-log"
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert [item["direction"] for item in payload["messages"]] == [
        "model_request", "model_response",
    ]
    assert payload["messages"][0]["payload"]["messages"][0]["content"] == "auth_token=***"
    assert payload["messages"][1]["payload"]["text"] == "done"


def test_creation_dashboard_aggregates_runs_jobs_and_scheduler_logs(client, monkeypatch):
    seed_source()

    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post(
        "/api/creation-rules", json=recurring_payload(target_count=3)
    ).json()
    creation_run = client.post(
        f"/api/creation-rules/{rule['id']}/run"
    ).json()

    from database import SessionLocal
    from models import (
        AgentExecution, AgentToolCall, CollectLog, ContentJob,
        ContentJobEvent, ContentJobStep, DailyCreationRun,
    )

    cn_tz = timezone(timedelta(hours=8))
    scheduled_for = datetime.combine(
        datetime.now(cn_tz).date(), time(8), cn_tz,
    ).astimezone(timezone.utc)

    async def seed_dashboard_records():
        async with SessionLocal() as session:
            run = await session.get(DailyCreationRun, creation_run["id"])
            run.scheduled_for = scheduled_for
            run.status = "failed"
            run.created_count = 0
            job = ContentJob(
                flow="daily_creation", title="产品短帖", status="failed",
                input_data={"run_id": run.id},
                started_at=scheduled_for, completed_at=scheduled_for + timedelta(minutes=2),
            )
            session.add(job)
            await session.flush()
            run.content_job_id = job.id
            step = ContentJobStep(
                job_id=job.id, step_key="agent", attempt=1, status="failed",
                error="save_draft failed", retryable=False,
                started_at=scheduled_for, completed_at=scheduled_for + timedelta(minutes=1),
            )
            session.add(step)
            await session.flush()
            session.add(ContentJobEvent(
                job_id=job.id, step_id=step.id, kind="step_failed",
                payload={"message": "step failed"}, created_at=scheduled_for,
            ))
            execution = AgentExecution(
                job_id=job.id, status="failed", objective="private objective",
                phase="failed", error="missing valid evidence",
            )
            session.add(execution)
            await session.flush()
            session.add(AgentToolCall(
                execution_id=execution.id, tool_call_id="save-1",
                tool_name="save_draft", status="failed",
                error="atomic save failed",
            ))
            session.add(CollectLog(
                job="daily_creation", status="error",
                message="每日创作失败", detail="plan_item_ids",
                created_at=scheduled_for + timedelta(minutes=2),
            ))
            await session.commit()

    asyncio.run(seed_dashboard_records())
    response = client.get("/api/creation-rules/dashboard")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["date"] == datetime.now(cn_tz).date().isoformat()
    assert payload["summary"] == {
        "enabled_rules": 1, "scheduled_runs": 1, "queued": 0,
        "running": 0, "succeeded": 0, "partial": 0, "failed": 1,
        "cancelled": 0,
        "next_run_at": rule["next_run_at"],
    }
    assert payload["rules"][0]["id"] == rule["id"]
    dashboard_run = payload["runs"][0]
    assert dashboard_run["status"] == "failed"
    assert dashboard_run["requested_count"] == 0
    assert dashboard_run["created_count"] == 0
    assert dashboard_run["job"]["status"] == "failed"
    assert dashboard_run["job"]["steps"][0]["key"] == "agent"
    assert dashboard_run["job"]["events"][0]["kind"] == "step_failed"
    assert dashboard_run["agent_execution"]["status"] == "failed"
    assert dashboard_run["agent_execution"]["tools"][0]["tool_name"] == "save_draft"
    assert payload["scheduler_logs"][0]["message"] == "每日创作失败"


def test_worker_context_and_output_require_token(client, monkeypatch):
    asset_id = seed_source()

    async def fake_enqueue(_job_id):
        return None

    import job_queue
    monkeypatch.setattr(job_queue, "enqueue_job", fake_enqueue)
    rule = client.post(
        "/api/creation-rules", json=recurring_payload(target_count=1)
    ).json()
    creation_run = client.post(
        f"/api/creation-rules/{rule['id']}/run"
    ).json()
    base = f"/api/creation-rules/runs/{creation_run['id']}"
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

    legacy_completion = client.post(f"{base}/complete", headers=headers, json={
        "status": "succeeded", "created_count": 1,
        "detail": {"excluded": []},
    })
    assert legacy_completion.status_code == 400

import asyncio
import sys
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture
def client(monkeypatch, postgres_env):
    monkeypatch.setenv(
        "WORKER_TOKEN",
        "test-worker-token-at-least-32-characters",
    )
    monkeypatch.setenv("WORKER_QUEUE", "api-private-content-jobs")
    for module in list(sys.modules):
        if module.startswith(("database", "models", "content_jobs", "routers.jobs")):
            sys.modules.pop(module, None)
    from database import Base, SessionLocal, engine, get_db
    import models  # noqa: F401
    import routers.jobs as jobs_module
    router = jobs_module.router

    async def no_op_enqueue(_job_id: int):
        return None

    monkeypatch.setattr(jobs_module, "enqueue_job", no_op_enqueue)

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.new_event_loop().run_until_complete(setup())
    app = FastAPI()
    app.include_router(router, prefix="/api")

    async def override_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    return TestClient(app)


def test_create_job_returns_queued_job(client):
    response = client.post("/api/jobs", json={
        "flow": "draft", "title": "Test", "input": {}, "idempotency_key": "one",
    })

    assert response.status_code == 201
    assert response.json()["status"] == "queued"
    assert response.json()["id"] > 0


def _pipeline_invocation(name="source-research", invocation_id="one"):
    return {
        "invocation_id": invocation_id,
        "skill_name": name,
        "skill_display_name": name,
        "skill_snapshot": {
            "name": name,
            "version": "1.0.0",
            "digest": "a" * 64,
            "source": "builtin",
        },
        "binding_snapshot": {
            "primaryOutput": "article",
            "capabilityProfile": "writing",
            "requestedAllowedTools": ["read_context"],
            "profileAllowedTools": ["read_context"],
        },
        "capability_snapshot": {
            "schemaVersion": 1,
            "mode": "job",
            "skill": {"name": name},
            "tools": [],
            "policy": {
                "approvalPolicy": "automatic",
                "allowedToolNames": ["read_context"],
            },
        },
    }


def _pipeline_body(*, key="job:pipeline:1", confirmation="automatic"):
    return {
        "flow": "skill_pipeline",
        "title": "Pipeline API",
        "objective": "Write a sourced article",
        "confirmation": confirmation,
        "invocations": [
            _pipeline_invocation("source-research", "one"),
            _pipeline_invocation("humanize-writing", "two"),
        ],
        "idempotency_key": key,
    }


def test_skill_pipeline_job_requires_worker_auth_and_automatic_enqueue_is_idempotent(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    body = _pipeline_body()

    denied = client.post("/api/jobs", json=body)
    assert denied.status_code == 403

    created = client.post(
        "/api/jobs",
        json=body,
        headers={"X-Worker-Token": "test-worker-token-at-least-32-characters"},
    )
    assert created.status_code == 201, created.text
    payload = created.json()
    assert payload["flow"] == "skill_pipeline"
    assert payload["status"] == "queued"
    assert payload["plan_version"] == 1
    assert [stage["key"] for stage in payload["pipeline"]["stages"]] == [
        "skill:01:source-research",
        "skill:02:humanize-writing",
    ]
    assert queued == [payload["id"]]

    repeated = client.post(
        "/api/jobs",
        json=body,
        headers={"X-Worker-Token": "test-worker-token-at-least-32-characters"},
    )
    assert repeated.status_code == 201
    assert repeated.json()["id"] == payload["id"]


def test_list_jobs_returns_complete_top_level_steps_for_skill_pipeline(client):
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    created = client.post(
        "/api/jobs",
        json=_pipeline_body(key="job:pipeline:list-contract"),
        headers=headers,
    ).json()

    response = client.get("/api/jobs?limit=30")

    assert response.status_code == 200, response.text
    listed = next(
        job for job in response.json()["jobs"] if job["id"] == created["id"]
    )
    assert [step["key"] for step in listed["steps"]] == [
        "pipeline_plan",
        "skill:01:source-research",
        "skill:02:humanize-writing",
    ]
    assert set(listed["steps"][0]) >= {
        "id", "key", "attempt", "status", "output", "error",
        "retryable", "created_at", "started_at", "completed_at",
    }


def test_worker_pipeline_stage_routes_are_authenticated_and_queue_next_stage_once(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    created = client.post(
        "/api/jobs",
        json=_pipeline_body(key="job:pipeline:worker-stage"),
        headers=headers,
    ).json()
    # Job creation enqueues the first Stage; isolate the completion assertion
    # from that initial dispatch.
    queued.clear()
    stage = created["pipeline"]["stages"][0]
    start_path = f"/api/jobs/{created['id']}/pipeline/stages/{stage['id']}/start"

    assert client.post(start_path, json={"attempt": 1, "run_epoch": 1}).status_code == 403
    started = client.post(
        start_path,
        json={"attempt": 1, "run_epoch": 1},
        headers=headers,
    )
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "running"

    from database import SessionLocal
    from models import AgentExecution

    async def seed_execution():
        async with SessionLocal() as session:
            execution = AgentExecution(
                job_id=created["id"],
                step_id=stage["id"],
                attempt=1,
                objective="Write a sourced article",
                skill_mode="manual",
                skill_name="source-research",
            )
            session.add(execution)
            await session.commit()
            await session.refresh(execution)
            return execution.id

    execution_id = asyncio.new_event_loop().run_until_complete(seed_execution())
    complete_path = f"/api/jobs/{created['id']}/pipeline/stages/{stage['id']}/complete"
    body = {
        "attempt": 1,
        "run_epoch": 1,
        "execution_id": execution_id,
        "primary": {
            "kind": "research_bundle",
            "title": "Research",
            "text_content": "source findings",
        },
        "auxiliary": [],
        "completion_evidence": {"kind": "agent_run", "finalText": "source findings"},
    }
    completed = client.post(complete_path, json=body, headers=headers)
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "queued"
    assert queued == [created["id"]]

    repeated = client.post(complete_path, json=body, headers=headers)
    assert repeated.status_code == 200, repeated.text
    assert queued == [created["id"]]


def test_worker_pipeline_final_stage_projects_one_normal_chat_message(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    body = _pipeline_body(key="job:pipeline:worker-final")
    body["invocations"] = [_pipeline_invocation("source-research", "one")]
    created = client.post("/api/jobs", json=body, headers=headers).json()
    queued.clear()
    stage = created["pipeline"]["stages"][0]
    start_path = f"/api/jobs/{created['id']}/pipeline/stages/{stage['id']}/start"
    complete_path = f"/api/jobs/{created['id']}/pipeline/stages/{stage['id']}/complete"

    from database import SessionLocal
    from models import AgentExecution, ChatMessage, ChatSession, ContentJobEvent

    async def seed_chat_and_execution():
        async with SessionLocal() as session:
            chat_session = ChatSession(title="Pipeline Chat")
            session.add(chat_session)
            await session.flush()
            placeholder = ChatMessage(
                session_id=chat_session.id,
                role="assistant",
                text="等待确认",
                parts=[{"type": "skill-pipeline-ref", "jobId": created["id"]}],
            )
            session.add(placeholder)
            await session.flush()
            session.add(ContentJobEvent(
                job_id=created["id"],
                kind="chat_pipeline_created",
                payload={"session_id": chat_session.id, "assistant_message_id": placeholder.id},
            ))
            execution = AgentExecution(
                job_id=created["id"],
                step_id=stage["id"],
                attempt=1,
                objective="Write a sourced article",
                skill_mode="manual",
                skill_name="source-research",
            )
            session.add(execution)
            await session.commit()
            await session.refresh(execution)
            return chat_session.id, execution.id

    assert client.post(start_path, json={"attempt": 1, "run_epoch": 1}, headers=headers).status_code == 200
    session_id, execution_id = asyncio.new_event_loop().run_until_complete(seed_chat_and_execution())
    payload = {
        "attempt": 1,
        "run_epoch": 1,
        "execution_id": execution_id,
        "primary": {
            "kind": "research_bundle",
            "title": "Research",
            "text_content": "Final research output",
        },
        "auxiliary": [],
        "completion_evidence": {"kind": "agent_run", "finalText": "Final research output"},
    }

    completed = client.post(complete_path, json=payload, headers=headers)
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "succeeded"
    assert queued == []

    async def chat_messages():
        async with SessionLocal() as session:
            return list((await session.execute(
                select(ChatMessage)
                .where(ChatMessage.session_id == session_id)
                .order_by(ChatMessage.id.asc())
            )).scalars().all())

    messages = asyncio.new_event_loop().run_until_complete(chat_messages())
    assert len(messages) == 2
    assert messages[-1].text == "Final research output"
    assert messages[-1].parts[0]["pipelineJobId"] == created["id"]

    repeated = client.post(complete_path, json=payload, headers=headers)
    assert repeated.status_code == 200, repeated.text
    messages = asyncio.new_event_loop().run_until_complete(chat_messages())
    assert len(messages) == 2


def test_interactive_pipeline_waits_for_confirmation_and_hides_private_snapshot_fields(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    body = _pipeline_body(key="job:pipeline:interactive", confirmation="interactive")
    body["invocations"][0]["skill_snapshot"]["instructions"] = "private"
    response = client.post(
        "/api/jobs",
        json=body,
        headers={"X-Worker-Token": "test-worker-token-at-least-32-characters"},
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["status"] == "awaiting_confirmation"
    assert queued == []
    assert "instructions" not in repr(payload)


def test_pipeline_commands_are_versioned_and_events_have_an_ascending_cursor(client):
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    created = client.post(
        "/api/jobs",
        json=_pipeline_body(key="job:pipeline:commands", confirmation="interactive"),
        headers=headers,
    ).json()

    revised = client.post(
        f"/api/jobs/{created['id']}/plan/revise",
        json={
            "plan_version": 1,
            "request_id": "revise-api-1",
            "stage_instructions": {
                "skill:01:source-research": "Prefer primary sources.",
            },
        },
    )
    assert revised.status_code == 200, revised.text
    assert revised.json()["plan_version"] == 2

    stale = client.post(
        f"/api/jobs/{created['id']}/confirm",
        json={"plan_version": 1, "request_id": "confirm-stale"},
    )
    assert stale.status_code == 409

    confirmed = client.post(
        f"/api/jobs/{created['id']}/confirm",
        json={"plan_version": 2, "request_id": "confirm-api-1"},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "queued"

    events = client.get(f"/api/jobs/{created['id']}/events?after=0")
    assert events.status_code == 200
    event_ids = [event["id"] for event in events.json()["events"]]
    assert event_ids == sorted(event_ids)
    assert any(event["kind"] == "pipeline_command" for event in events.json()["events"])


def test_pipeline_stage_retry_and_rerun_routes_preserve_attempt_history(client, monkeypatch):
    import routers.jobs as jobs_router

    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-characters"}
    retry_job = client.post(
        "/api/jobs",
        json=_pipeline_body(key="job:pipeline:retry-route", confirmation="automatic"),
        headers=headers,
    ).json()

    from database import SessionLocal
    from execution_artifacts import append_execution_artifact
    from models import ContentJob, ContentJobStep

    async def seed_retry_and_rerun():
        async with SessionLocal() as session:
            retry_record = await session.get(ContentJob, retry_job["id"])
            retry_steps = list((await session.execute(
                select(ContentJobStep)
                .where(
                    ContentJobStep.job_id == retry_record.id,
                    ContentJobStep.step_key != "pipeline_plan",
                )
                .order_by(ContentJobStep.id)
            )).scalars().all())
            retry_steps[0].status = "failed"
            retry_steps[0].retryable = True
            retry_record.status = "failed"
            await session.commit()

            return retry_steps[0].step_key

    retry_key = asyncio.new_event_loop().run_until_complete(seed_retry_and_rerun())
    retried = client.post(
        f"/api/jobs/{retry_job['id']}/stages/{retry_key}/retry",
        json={"request_id": "retry-route-1"},
    )
    assert retried.status_code == 200, retried.text
    assert any(
        stage["key"] == retry_key and stage["attempt"] == 2 and stage["status"] == "queued"
        for stage in retried.json()["pipeline"]["stages"]
    )

    rerun_job = client.post(
        "/api/jobs",
        json=_pipeline_body(key="job:pipeline:rerun-route", confirmation="automatic"),
        headers=headers,
    ).json()

    async def seed_rerun():
        async with SessionLocal() as session:
            record = await session.get(ContentJob, rerun_job["id"])
            steps = list((await session.execute(
                select(ContentJobStep)
                .where(
                    ContentJobStep.job_id == record.id,
                    ContentJobStep.step_key != "pipeline_plan",
                )
                .order_by(ContentJobStep.id)
            )).scalars().all())
            for step in steps:
                step.status = "succeeded"
                await append_execution_artifact(
                    session,
                    job_id=record.id,
                    step_id=step.id,
                    attempt=step.attempt,
                    kind="article",
                    role="primary",
                    title=step.step_key,
                    text_content=f"{step.step_key} output",
                )
            record.status = "succeeded"
            await session.commit()
            return steps[0].step_key

    rerun_key = asyncio.new_event_loop().run_until_complete(seed_rerun())
    rerun = client.post(
        f"/api/jobs/{rerun_job['id']}/stages/{rerun_key}/rerun",
        json={"request_id": "rerun-route-1"},
    )
    assert rerun.status_code == 200, rerun.text
    assert rerun.json()["status"] == "queued"
    assert any(stage["status"] == "superseded" for stage in rerun.json()["pipeline"]["stages"])


def test_list_jobs_returns_stable_cursor_pages(client):
    created_ids = [
        client.post("/api/jobs", json={"flow": "draft", "title": f"Job {index}", "input": {}}).json()["id"]
        for index in range(3)
    ]

    first = client.get("/api/jobs?limit=2")
    assert first.status_code == 200
    first_payload = first.json()
    assert [job["id"] for job in first_payload["jobs"]] == created_ids[::-1][:2]
    assert first_payload["has_more"] is True
    assert first_payload["next_cursor"]

    second = client.get(
        f"/api/jobs?limit=2&cursor={first_payload['next_cursor']}"
    )
    assert second.status_code == 200
    assert [job["id"] for job in second.json()["jobs"]] == [created_ids[0]]
    assert second.json()["has_more"] is False
    assert second.json()["next_cursor"] is None


def test_list_jobs_filters_scheduled_jobs_and_exposes_schedule_summary(client):
    scheduled = client.post("/api/jobs", json={
        "flow": "daily_creation", "title": "定时短帖", "input": {},
    }).json()
    manual = client.post("/api/jobs", json={
        "flow": "draft", "title": "手动草稿", "input": {},
    }).json()

    from database import SessionLocal
    from models import DailyCreationRun

    async def seed_schedule():
        async with SessionLocal() as session:
            session.add(DailyCreationRun(
                rule_id=99,
                content_job_id=scheduled["id"],
                scheduled_for=datetime(2026, 8, 6, 1, 30, tzinfo=timezone.utc),
                trigger_kind="schedule",
                requested_count=3,
                rule_snapshot={"name": "每日短帖", "directory": "产品实验"},
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(seed_schedule())

    scheduled_response = client.get("/api/jobs?kind=scheduled")
    assert scheduled_response.status_code == 200
    scheduled_jobs = scheduled_response.json()["jobs"]
    assert [job["id"] for job in scheduled_jobs] == [scheduled["id"]]
    assert scheduled_jobs[0]["schedule"] == {
        "run_id": 1,
        "rule_name": "每日短帖",
        "trigger_kind": "schedule",
        "scheduled_for": "2026-08-06T01:30:00+00:00",
    }

    manual_response = client.get("/api/jobs?kind=manual")
    assert manual_response.status_code == 200
    assert [job["id"] for job in manual_response.json()["jobs"]] == [manual["id"]]


def test_list_jobs_filters_by_status_and_rejects_malformed_cursor(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "失败任务", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()
    client.post(
        f"/api/jobs/{created['id']}/steps/{started['id']}/fail",
        json={"error": "failed", "retryable": False},
    )

    failed = client.get("/api/jobs?status=failed")
    assert failed.status_code == 200
    assert [job["id"] for job in failed.json()["jobs"]] == [created["id"]]

    malformed = client.get("/api/jobs?cursor=not-a-valid-cursor")
    assert malformed.status_code == 400


def test_create_job_enqueues_worker_execution(client, monkeypatch):
    import routers.jobs as jobs_router
    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    response = client.post("/api/jobs", json={"flow": "draft", "title": "Queued", "input": {}})

    assert response.status_code == 201
    assert queued == [response.json()["id"]]


def test_retry_unknown_job_returns_404(client):
    response = client.post("/api/jobs/999/retry", json={"step_key": "draft"})

    assert response.status_code == 404


def test_retry_enqueues_job_again(client, monkeypatch):
    import routers.jobs as jobs_router
    queued: list[int] = []

    async def enqueue(job_id: int):
        queued.append(job_id)

    monkeypatch.setattr(jobs_router, "enqueue_job", enqueue)
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Retry", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()
    client.post(f"/api/jobs/{created['id']}/steps/{started['id']}/fail", json={"error": "timeout", "retryable": True})

    response = client.post(f"/api/jobs/{created['id']}/retry", json={"step_key": "draft"})

    assert response.status_code == 200
    assert queued == [created["id"], created["id"]]


def test_step_lifecycle_api_records_success(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Lifecycle", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/brief/start")

    assert started.status_code == 200
    assert started.json()["status"] == "running"

    completed = client.post(f"/api/jobs/{created['id']}/steps/{started.json()['id']}/succeed", json={"output": {"brief": "ok"}})
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"


def test_job_event_api_persists_auditable_generation_trace(client):
    created = client.post("/api/jobs", json={"flow": "cover", "title": "Trace", "input": {}}).json()

    response = client.post(
        f"/api/jobs/{created['id']}/events",
        json={"kind": "skill_loaded", "payload": {"skill": "baoyu-cover-image"}},
    )

    assert response.status_code == 201
    job = client.get(f"/api/jobs/{created['id']}").json()
    assert job["events"][0]["kind"] == "skill_loaded"
    assert job["events"][0]["payload"] == {"skill": "baoyu-cover-image"}


def test_job_agent_log_returns_full_message_timeline(client):
    created = client.post("/api/jobs", json={"flow": "cover", "title": "Agent log", "input": {}}).json()

    from database import SessionLocal
    from models import AgentExecution, AgentMessageLog, ContentJob

    async def seed_messages():
        async with SessionLocal() as session:
            job = await session.get(ContentJob, created["id"])
            execution = AgentExecution(
                job_id=job.id,
                status="succeeded",
                objective="create a cover",
                skill_mode="auto",
                phase="complete",
            )
            session.add(execution)
            await session.flush()
            session.add(AgentMessageLog(
                execution_id=execution.id,
                phase="execute",
                direction="model_response",
                payload_data={"text": "cover ready"},
            ))
            await session.commit()

    asyncio.new_event_loop().run_until_complete(seed_messages())

    response = client.get(f"/api/jobs/{created['id']}/agent-log")

    assert response.status_code == 200, response.text
    assert response.json()["messages"][0]["payload"]["text"] == "cover ready"


def test_job_agent_log_uses_newest_stage_execution(client):
    created = client.post(
        "/api/jobs", json={"flow": "skill_pipeline", "title": "Latest", "input": {}}
    ).json()

    from database import SessionLocal
    from models import AgentExecution, ContentJobStep

    async def seed_executions():
        async with SessionLocal() as session:
            steps = [
                ContentJobStep(job_id=created["id"], step_key="research", attempt=1),
                ContentJobStep(job_id=created["id"], step_key="write", attempt=1),
            ]
            session.add_all(steps)
            await session.flush()
            executions = [
                AgentExecution(
                    job_id=created["id"], step_id=steps[0].id, attempt=1,
                    objective="old", status="succeeded",
                ),
                AgentExecution(
                    job_id=created["id"], step_id=steps[1].id, attempt=1,
                    objective="new", status="running",
                ),
            ]
            session.add_all(executions)
            await session.commit()
            return executions[1].id, steps[1].id

    newest_id, newest_step_id = asyncio.new_event_loop().run_until_complete(
        seed_executions()
    )
    response = client.get(f"/api/jobs/{created['id']}/agent-log")

    assert response.status_code == 200, response.text
    assert response.json()["execution"]["id"] == newest_id
    assert response.json()["execution"]["step_id"] == newest_step_id


def test_worker_reconcile_requires_worker_auth_takes_no_body_and_closes_queue(
    client,
    monkeypatch,
):
    import routers.jobs as jobs_router

    calls: list[object] = []

    class FakeQueue:
        def __init__(self, *args, **kwargs):
            assert args == ()
            self.kwargs = kwargs
            calls.append(("queue-created", kwargs))

        @property
        def name(self):
            return self.kwargs.get("queue_name") or "api-private-content-jobs"

        async def __aenter__(self):
            calls.append(("queue-open", self.name))
            return self

        async def __aexit__(self, *_args):
            calls.append(("queue-closed", self.name))

    async def reconcile(queue, video_queue=None, **_kwargs):
        calls.append(("reconcile", queue.name, getattr(video_queue, "name", None)))
        return {"enqueued": 2, "job_ids": [7, 8]}

    monkeypatch.setattr(jobs_router, "RedisJobQueue", FakeQueue)
    monkeypatch.setattr(
        jobs_router,
        "reconcile_content_jobs",
        reconcile,
    )

    denied = client.post("/api/jobs/worker-reconcile")
    assert denied.status_code == 403

    response = client.post(
        "/api/jobs/worker-reconcile",
        headers={
            "X-Worker-Token":
                "test-worker-token-at-least-32-characters",
        },
    )
    assert response.status_code == 200
    assert response.json() == {"enqueued": 2, "job_ids": [7, 8]}
    assert calls == [
        ("queue-created", {}),
        ("queue-open", "api-private-content-jobs"),
        ("queue-created", {"queue_name": "content-jobs:video"}),
        ("queue-open", "content-jobs:video"),
        ("reconcile", "api-private-content-jobs", "content-jobs:video"),
        ("queue-closed", "content-jobs:video"),
        ("queue-closed", "api-private-content-jobs"),
    ]
    operation = client.app.openapi()["paths"][
        "/api/jobs/worker-reconcile"
    ]["post"]
    assert "requestBody" not in operation


def test_step_failure_marks_job_failed_and_retryable(client):
    created = client.post("/api/jobs", json={"flow": "draft", "title": "Failure", "input": {}}).json()
    started = client.post(f"/api/jobs/{created['id']}/steps/draft/start").json()

    failed = client.post(
        f"/api/jobs/{created['id']}/steps/{started['id']}/fail",
        json={"error": "provider timeout", "retryable": True},
    )

    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    assert failed.json()["retryable"] is True
    assert client.get(f"/api/jobs/{created['id']}").json()["status"] == "failed"

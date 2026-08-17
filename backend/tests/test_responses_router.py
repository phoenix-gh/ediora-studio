import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select


@pytest.fixture
def client(monkeypatch, postgres_env):
    for name in list(sys.modules):
        if name.startswith(("database", "models", "main", "routers", "config", "content_response")):
            sys.modules.pop(name, None)
    from database import Base, engine
    import models  # noqa: F401

    async def create_schema():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    from main import app
    from routers import responses as responses_router

    async def no_op_enqueue(_job_id):
        return None

    monkeypatch.setattr(responses_router, "enqueue_job", no_op_enqueue)
    monkeypatch.setenv("WORKER_TOKEN", "test-worker-token-at-least-32-chars")
    return TestClient(app)


def _analysis():
    return {
        "content_value_score": 90,
        "value_dimensions": {
            key: {"score": 80, "reason": "理由"}
            for key in (
                "novelty",
                "practicality",
                "credibility",
                "writing_space",
                "evergreen_value",
            )
        },
        "summary_cn": "摘要",
        "core_thesis": "核心判断",
        "value_points": ["价值点"],
        "evidence": [{"text": "证据", "type": "source_claim"}],
        "risks": [],
        "verification_items": [],
        "recommended_content_types": ["tool"],
        "recommended_disposition": "worth_writing",
        "recommendation_reason": "值得写",
        "suggested_title": "建议标题",
        "suggested_angle": "实践角度",
        "target_reader": "创作者",
        "suggested_structure": ["开篇", "论证"],
    }


def _seed_response():
    from database import SessionLocal
    from models import ContentAnalysisRun, ContentResponseItem, XPost

    async def seed():
        async with SessionLocal() as db:
            post = XPost(
                tweet_id="router-post",
                subscription_id=1,
                username="author",
                content="完整 X 原文",
                raw_markdown="完整 X Markdown",
                url="https://x.com/author/status/router-post",
                published_at=datetime.now(timezone.utc),
            )
            item = ContentResponseItem(
                source_type="x_post",
                source_id=post.tweet_id,
                source_url=post.url,
                source_title=post.content,
                content_types=["tool"],
                subscription_id=1,
            )
            db.add_all([post, item])
            await db.flush()
            run = ContentAnalysisRun(
                response_item_id=item.id,
                version=1,
                status="succeeded",
                **_analysis(),
            )
            db.add(run)
            await db.flush()
            item.current_analysis_run_id = run.id
            await db.commit()
            return item.id, run.id

    return asyncio.run(seed())


def _seed_response_time_range():
    from database import SessionLocal
    from models import ContentResponseItem

    async def seed():
        async with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            recent = ContentResponseItem(
                source_type="x_post",
                source_id="recent-post",
                source_url="https://x.com/author/status/recent-post",
                source_title="最近内容",
                source_published_at=now - timedelta(days=1),
                content_types=["tool"],
            )
            old = ContentResponseItem(
                source_type="x_post",
                source_id="old-post",
                source_url="https://x.com/author/status/old-post",
                source_title="较早内容",
                source_published_at=now - timedelta(days=4),
                content_types=["tool"],
            )
            db.add_all([recent, old])
            await db.commit()
            return recent.id, old.id

    return asyncio.run(seed())


def test_detail_normalizes_full_source_and_list_omits_source_body(client):
    item_id, run_id = _seed_response()

    listing = client.get("/api/responses", params={"sort": "score"})
    assert listing.status_code == 200, listing.text
    row = listing.json()["items"][0]
    assert "content" not in row
    assert "raw_markdown" not in row
    assert listing.json()["counts"]["pending"] == 1

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["source"]["content"] == "完整 X 原文"
    assert body["source"]["raw_markdown"] == "完整 X Markdown"
    assert body["analysis"]["suggested_angle"] == "实践角度"
    assert body["content_types"] == ["tool"]
    assert body["subscription_id"] == 1


def test_list_filters_response_items_by_source_time_window(client):
    recent_id, old_id = _seed_response_time_range()

    default_listing = client.get("/api/responses")
    assert default_listing.status_code == 200, default_listing.text
    assert [item["id"] for item in default_listing.json()["items"]] == [recent_id]

    seven_day_listing = client.get("/api/responses", params={"days": 7})
    assert seven_day_listing.status_code == 200, seven_day_listing.text
    assert {item["id"] for item in seven_day_listing.json()["items"]} == {recent_id, old_id}

    unlimited_listing = client.get("/api/responses", params={"days": 0})
    assert unlimited_listing.status_code == 200, unlimited_listing.text
    assert {item["id"] for item in unlimited_listing.json()["items"]} == {recent_id, old_id}


def test_classification_decision_and_asset_destination_are_idempotent(client):
    item_id, run_id = _seed_response()

    classified = client.post(
        f"/api/responses/{item_id}/classification",
        json={"content_types": ["research", "tutorial"]},
    )
    assert classified.status_code == 200, classified.text
    assert classified.json()["content_types"] == ["research", "tutorial"]

    ignored = client.post(
        f"/api/responses/{item_id}/decision",
        json={"action": "not_processed", "reason": "暂不处理"},
    )
    assert ignored.status_code == 200, ignored.text
    assert ignored.json()["decision_status"] == "not_processed"

    reset = client.post(
        f"/api/responses/{item_id}/decision",
        json={"action": "reset"},
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["decision_status"] == "pending"

    first = client.post(
        f"/api/responses/{item_id}/destination",
        json={"destination": "creative_asset", "analysis_run_id": run_id},
    )
    second = client.post(
        f"/api/responses/{item_id}/destination",
        json={"destination": "creative_asset", "analysis_run_id": run_id},
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == second.json()
    assert first.json()["url"].startswith("/assets?selected=")


def test_draft_destination_api_cannot_bypass_the_writing_job(client):
    item_id, run_id = _seed_response()

    response = client.post(
        f"/api/responses/{item_id}/destination",
        json={"destination": "draft", "analysis_run_id": run_id},
    )

    assert response.status_code == 422, response.text


def test_worth_writing_queues_one_expanded_article_job_and_exposes_status(client):
    item_id, run_id = _seed_response()

    first = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    second = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_output = first.json()["outputs"][0]
    second_output = second.json()["outputs"][0]
    assert first_output["output_type"] == "expanded_article"
    assert first_output["created"] is True
    assert second_output["created"] is False
    assert second_output["id"] == first_output["id"]
    assert second_output["job_id"] == first_output["job_id"]

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["decision_status"] == "worth_writing"
    assert body["selected_output_types"] == ["expanded_article"]
    assert body["outputs"] == [{
        "id": first_output["id"],
        "output_type": "expanded_article",
        "status": "queued",
        "job_id": first_output["job_id"],
        "job_status": "queued",
        "article_draft_id": None,
        "content": "",
        "error_code": "",
        "error": "",
    }]


def test_multi_platform_writing_creates_one_job_per_request_target_and_allows_later_variants(client):
    item_id, run_id = _seed_response()

    first = client.post(
        f"/api/responses/{item_id}/outputs",
        json={
            "analysis_run_id": run_id,
            "output_types": [
                "x_short_post",
                "x_article",
                "wechat_article",
                "x_short_post",
            ],
        },
    )

    assert first.status_code == 200, first.text
    first_outputs = first.json()["outputs"]
    assert [row["output_type"] for row in first_outputs] == [
        "x_short_post",
        "x_article",
        "wechat_article",
    ]
    assert len({row["id"] for row in first_outputs}) == 3
    assert len({row["job_id"] for row in first_outputs}) == 3
    assert all(row["created"] is True for row in first_outputs)

    second = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["x_short_post"]},
    )

    assert second.status_code == 200, second.text
    second_output = second.json()["outputs"][0]
    assert second_output["created"] is True
    assert second_output["id"] not in {row["id"] for row in first_outputs}
    assert second_output["job_id"] not in {row["job_id"] for row in first_outputs}

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["decision_status"] == "worth_writing"
    assert len(body["outputs"]) == 4
    assert [row["output_type"] for row in body["outputs"]].count("x_short_post") == 2


def test_platform_writing_outputs_link_independent_drafts_with_exact_markers(client):
    item_id, run_id = _seed_response()
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-chars"}
    targets = [
        ("x_short_post", "x"),
        ("x_article", "x_article"),
        ("wechat_article", "mp"),
    ]
    linked: list[tuple[int, int, str]] = []

    for output_type, draft_type in targets:
        queued = client.post(
            f"/api/responses/{item_id}/outputs",
            json={"analysis_run_id": run_id, "output_types": [output_type]},
        )
        assert queued.status_code == 200, queued.text
        output_id = queued.json()["outputs"][0]["id"]
        draft = client.post("/api/write/drafts", json={
            "topic_id": f"response:{item_id}",
            "title": f"{output_type} 独立草稿",
            "content": f"{output_type} 完整正文",
            "status": "drafting",
            "draft_type": draft_type,
        })
        assert draft.status_code == 201, draft.text
        draft_id = draft.json()["id"]

        response = client.post(
            f"/api/responses/outputs/{output_id}/worker-link",
            headers=headers,
            json={"article_draft_id": draft_id},
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "id": output_id,
            "status": "draft_ready",
            "article_draft_id": draft_id,
        }
        linked.append((output_id, draft_id, output_type))

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    outputs = {row["id"]: row for row in detail.json()["outputs"]}
    for output_id, draft_id, output_type in linked:
        assert outputs[output_id]["output_type"] == output_type
        assert outputs[output_id]["article_draft_id"] == draft_id


def test_platform_writing_output_rejects_the_wrong_draft_marker(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["x_article"]},
    )
    assert queued.status_code == 200, queued.text
    output_id = queued.json()["outputs"][0]["id"]
    draft = client.post("/api/write/drafts", json={
        "topic_id": f"response:{item_id}",
        "title": "错误平台草稿",
        "content": "完整正文",
        "draft_type": "x",
    })
    assert draft.status_code == 201, draft.text

    response = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
        json={"article_draft_id": draft.json()["id"]},
    )

    assert response.status_code == 422, response.text
    assert "x_article" in response.json()["detail"]


def test_worker_result_creates_one_complete_draft_and_links_response_item(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    output_id = queued.json()["outputs"][0]["id"]
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-chars"}
    article_content = "# 完整文章标题\n\n这是写作 job 生成的完整文章正文。"
    body = {
        "title": "完整文章标题",
        "content": article_content,
        "source_attribution": {"url": "https://x.com/source/status/router-post"},
    }

    first = client.post(
        f"/api/responses/outputs/{output_id}/worker-result",
        headers=headers,
        json=body,
    )
    second = client.post(
        f"/api/responses/outputs/{output_id}/worker-result",
        headers=headers,
        json=body,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json() == second.json()
    draft_id = first.json()["article_draft_id"]
    assert draft_id

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["destination"] == {
        "type": "draft",
        "id": draft_id,
        "url": f"/drafts?draft={draft_id}",
    }
    assert body["outputs"][0]["status"] == "draft_ready"
    assert body["outputs"][0]["article_draft_id"] == draft_id

    from database import SessionLocal
    from models import ArticleDraft, ContentResponseItem

    async def readback():
        async with SessionLocal() as db:
            item = await db.get(ContentResponseItem, item_id)
            drafts = (await db.execute(
                select(ArticleDraft).where(ArticleDraft.topic_id == f"response:{item_id}")
            )).scalars().all()
            return item, drafts

    item, drafts = asyncio.run(readback())
    assert item.destination_type == "draft"
    assert item.destination_id == draft_id
    assert len(drafts) == 1
    assert drafts[0].content == article_content


def test_worker_link_reuses_agent_saved_draft_without_creating_another(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    output_id = queued.json()["outputs"][0]["id"]
    draft = client.post("/api/write/drafts", json={
        "topic_id": f"response:{item_id}",
        "title": "Agent 文章",
        "content": "# Agent 文章\n\n这是完整正文。",
        "status": "drafting",
        "draft_type": "article",
    })
    assert draft.status_code == 201, draft.text
    draft_id = draft.json()["id"]
    headers = {"X-Worker-Token": "test-worker-token-at-least-32-chars"}

    first = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        headers=headers,
        json={"article_draft_id": draft_id},
    )
    second = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        headers=headers,
        json={"article_draft_id": draft_id},
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    expected = {
        "id": output_id,
        "status": "draft_ready",
        "article_draft_id": draft_id,
    }
    assert first.json() == expected
    assert second.json() == expected

    detail = client.get(f"/api/responses/{item_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["destination"] == {
        "type": "draft",
        "id": draft_id,
        "url": f"/drafts?draft={draft_id}",
    }
    assert body["outputs"][0]["status"] == "draft_ready"
    assert body["outputs"][0]["article_draft_id"] == draft_id


def test_worker_link_rejects_a_draft_that_does_not_belong_to_the_response(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    output_id = queued.json()["outputs"][0]["id"]
    draft = client.post("/api/write/drafts", json={
        "topic_id": "manual",
        "title": "其他草稿",
        "content": "完整正文",
        "draft_type": "article",
    })
    assert draft.status_code == 201, draft.text

    response = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        headers={"X-Worker-Token": "test-worker-token-at-least-32-chars"},
        json={"article_draft_id": draft.json()["id"]},
    )

    assert response.status_code == 409, response.text
    assert "topic_id" in response.json()["detail"]


def test_worker_link_requires_worker_token(client):
    item_id, run_id = _seed_response()
    queued = client.post(
        f"/api/responses/{item_id}/outputs",
        json={"analysis_run_id": run_id, "output_types": ["expanded_article"]},
    )
    output_id = queued.json()["outputs"][0]["id"]

    response = client.post(
        f"/api/responses/outputs/{output_id}/worker-link",
        json={"article_draft_id": 1},
    )

    assert response.status_code == 403, response.text

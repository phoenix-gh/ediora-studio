import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from remote_image_import import RemoteImageImportResult


@pytest.fixture
def api(monkeypatch):
    sys.modules.pop("routers.assets", None)
    import routers.assets as router_module
    from database import get_db

    async def database_must_not_be_opened():
        raise AssertionError("inline image import must not open a database session")
        yield

    app = FastAPI()
    app.include_router(router_module.router, prefix="/api")
    app.dependency_overrides[get_db] = database_must_not_be_opened
    return TestClient(app), router_module


def test_asset_image_import_returns_ordered_per_item_results(api, monkeypatch):
    client, router_module = api
    captured = {}

    async def fake_import(urls, uploads_dir):
        captured["urls"] = urls
        captured["uploads_dir"] = uploads_dir
        return [
            RemoteImageImportResult(
                source_url=urls[0],
                url="/api/uploads/a.png",
            ),
            RemoteImageImportResult(
                source_url=urls[1],
                error_code="timeout",
                error="图片下载超时",
            ),
        ]

    monkeypatch.setattr(router_module, "import_remote_images", fake_import)

    response = client.post(
        "/api/assets/images/import",
        json={
            "urls": [
                "https://img.example/a.png",
                "https://img.example/b.png",
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [
            {
                "source_url": "https://img.example/a.png",
                "url": "/api/uploads/a.png",
                "error_code": "",
                "error": "",
            },
            {
                "source_url": "https://img.example/b.png",
                "url": "",
                "error_code": "timeout",
                "error": "图片下载超时",
            },
        ]
    }
    assert captured["urls"] == [
        "https://img.example/a.png",
        "https://img.example/b.png",
    ]
    assert captured["uploads_dir"].name == "uploads"


@pytest.mark.parametrize("urls", [[], [f"https://img.example/{index}.png" for index in range(21)]])
def test_asset_image_import_rejects_invalid_batch_sizes(api, urls):
    client, _ = api

    response = client.post(
        "/api/assets/images/import",
        json={"urls": urls},
    )

    assert response.status_code == 422


import asyncio
from copy import deepcopy


DEFAULT_RENDER_INPUT = {
    "templateId": "tech-text-v1",
    "templateVersion": 1,
    "composition": {"width": 1080, "height": 1920, "fps": 30},
    "audio": "",
    "segments": [{
        "id": "scene-1",
        "start": 0,
        "end": 2.4,
        "text": "在这里输入稿件",
        "highlight": [],
        "animation": "fade-up",
    }],
    "templateProps": {
        "theme": "tech-blue",
        "font": "source-han-sans",
        "background": "dark-grid",
        "transition": "soft-push",
        "textDensity": "standard",
        "brandTitle": "EDIORA",
        "brandSubtitle": "述策",
        "showBrand": True,
        "accentColor": "#69F6FF",
        "showProgress": True,
        "showSceneNumber": True,
    },
}


def make_speech_segment(
    segment_id: str,
    text: str,
    *,
    status: str = "draft",
    **overrides,
) -> dict:
    from text_video_domain import default_speech_segment

    return {
        **default_speech_segment(text, segment_id=segment_id),
        "status": status,
        **overrides,
    }


def make_master_audio(**overrides) -> dict:
    from text_video_domain import empty_master_audio

    return empty_master_audio() | overrides


def make_scene_plan(**overrides) -> dict:
    from text_video_domain import empty_scene_plan

    return empty_scene_plan() | overrides


def make_text_video_project(**overrides):
    from models import TextVideoProject

    values = {
        "title": "测试文字视频",
        "status": "draft",
        "stage": "script",
        "script": "",
        "voice_settings": {
            "voice_id": "mimo_default",
            "model": "mimo-v2.5-tts",
            "speed": 1,
            "volume": 1,
            "pitch": 0,
        },
        "paragraphs": [make_speech_segment("segment-1", "")],
        "speech_split_mode": "single",
        "master_audio": make_master_audio(),
        "scene_plan": make_scene_plan(),
        "render_input": deepcopy(DEFAULT_RENDER_INPUT),
        "output_stale": False,
        "revision": 1,
    }
    return TextVideoProject(**(values | overrides))


def run_async(coroutine):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coroutine)
    finally:
        loop.close()


def fresh_session_factory(monkeypatch, postgres_database_url):
    import sys
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    monkeypatch.setenv("WMS_DATABASE_URL", postgres_database_url)
    for module in list(sys.modules):
        if module.startswith(("database", "models", "routers.text_videos")):
            sys.modules.pop(module, None)

    from database import Base
    import models  # noqa: F401

    engine = create_async_engine(
        postgres_database_url,
        poolclass=NullPool,
    )
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def setup():
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    run_async(setup())
    return session_factory

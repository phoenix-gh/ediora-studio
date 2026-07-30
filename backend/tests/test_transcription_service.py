import asyncio
from contextlib import asynccontextmanager

import httpx

import transcription_service
from transcription_service import (
    TranscriptionRequest,
    transcribe_audio,
)


def _local_runtime(**overrides):
    return {
        "transcription_provider": "local-whisper",
        "transcription_max_duration_seconds": "60",
        "transcription_max_audio_bytes": "1024",
    } | overrides


def test_local_provider_posts_word_request_without_authorization(tmp_path):
    """Catches local mode accidentally requiring or sending a cloud API key."""
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")
    seen = {}

    async def handler(request: httpx.Request):
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers.get("Authorization")
        seen["body"] = await request.aread()
        return httpx.Response(
            200,
            headers={"X-Request-Id": "local-request-1"},
            json={
                "text": "甲乙",
                "language": "zh",
                "words": [
                    {"word": "甲", "start": 0, "end": 0.3},
                    {"word": "乙", "start": 0.3, "end": 0.6},
                ],
                "segments": [
                    {"text": "甲乙", "start": 0, "end": 0.6},
                ],
            },
        )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            return await transcribe_audio(
                TranscriptionRequest(
                    audio_path=audio,
                    duration=0.6,
                    require_word_timestamps=True,
                ),
                _local_runtime(),
                client=client,
            )

    result = asyncio.run(run())

    assert seen["url"] == (
        "http://local-asr:8000/v1/audio/transcriptions"
    )
    assert seen["authorization"] is None
    assert b"Systran/faster-whisper-large-v3" in seen["body"]
    assert b'name="response_format"' in seen["body"]
    assert b"verbose_json" in seen["body"]
    assert b'name="timestamp_granularities[]"' in seen["body"]
    assert b"word" in seen["body"]
    assert result.words == (
        {
            "id": "provider-1",
            "text": "甲",
            "start": 0.0,
            "end": 0.3,
        },
        {
            "id": "provider-2",
            "text": "乙",
            "start": 0.3,
            "end": 0.6,
        },
    )
    assert result.segments[0].text == "甲乙"
    assert result.request_id == "local-request-1"


def test_local_provider_normalizes_words_nested_in_segments(tmp_path):
    """Catches rejecting the verbose-json shape returned by Speaches."""
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")

    async def handler(_request: httpx.Request):
        return httpx.Response(
            200,
            json={
                "text": "本地字幕",
                "language": "zh",
                "segments": [
                    {
                        "text": "本地字幕",
                        "start": 0.1,
                        "end": 0.9,
                        "words": [
                            {"word": "本地", "start": 0.1, "end": 0.5},
                            {"word": "字幕", "start": 0.5, "end": 0.9},
                        ],
                    },
                ],
            },
        )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            return await transcribe_audio(
                TranscriptionRequest(
                    audio_path=audio,
                    duration=1.0,
                    require_word_timestamps=True,
                ),
                _local_runtime(),
                client=client,
            )

    result = asyncio.run(run())

    assert [word["text"] for word in result.words] == ["本地", "字幕"]
    assert [(item.start, item.end) for item in result.segments] == [
        (0.1, 0.9),
    ]


def test_local_provider_installs_missing_model_then_retries_once(tmp_path):
    """Catches fresh Speaches volumes failing every first transcription."""
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")
    seen_paths = []

    async def handler(request: httpx.Request):
        seen_paths.append(request.url.raw_path.decode())
        if len(seen_paths) == 1:
            return httpx.Response(
                404,
                json={
                    "detail": (
                        "Model 'Systran/faster-whisper-large-v3' "
                        "is not installed locally."
                    ),
                },
            )
        if len(seen_paths) == 2:
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json={
                "text": "甲",
                "language": "zh",
                "words": [
                    {"word": "甲", "start": 0, "end": 0.5},
                ],
            },
        )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            return await transcribe_audio(
                TranscriptionRequest(audio_path=audio, duration=0.5),
                _local_runtime(),
                client=client,
            )

    result = asyncio.run(run())

    assert seen_paths == [
        "/v1/audio/transcriptions",
        "/v1/models/Systran%2Ffaster-whisper-large-v3",
        "/v1/audio/transcriptions",
    ]
    assert result.text == "甲"


def test_production_local_request_holds_gpu_gate_around_http_inference(
    tmp_path,
    monkeypatch,
):
    """Catches local HTTP inference bypassing cross-process serialization."""
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")
    events = []

    @asynccontextmanager
    async def fake_gate(*, owner):
        assert owner.startswith("asr-")
        events.append("gate-enter")
        try:
            yield
        finally:
            events.append("gate-exit")

    class FakeClient:
        async def post(self, *_args, **_kwargs):
            events.append("post")
            return httpx.Response(
                200,
                json={
                    "text": "甲",
                    "language": "zh",
                    "words": [
                        {"word": "甲", "start": 0, "end": 0.5},
                    ],
                },
            )

    @asynccontextmanager
    async def fake_client_scope(_client, *, duration):
        assert duration == 0.5
        yield FakeClient()

    monkeypatch.setattr(transcription_service, "local_asr_gate", fake_gate)
    monkeypatch.setattr(
        transcription_service,
        "_client_scope",
        fake_client_scope,
    )

    result = asyncio.run(transcribe_audio(
        TranscriptionRequest(audio_path=audio, duration=0.5),
        _local_runtime(),
    ))

    assert result.text == "甲"
    assert events == ["gate-enter", "post", "gate-exit"]

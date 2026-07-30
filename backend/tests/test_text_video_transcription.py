import asyncio
import json

import httpx
import pytest

from text_video_transcription import (
    TranscriptionError,
    transcribe_audio_words,
)


def _runtime(**overrides):
    return {
        "transcription_provider": "openai-compatible",
        "transcription_model": "whisper-1",
        "transcription_base_url": "https://speech.example/v1",
        "transcription_api_key": "secret-value",
        "transcription_max_duration_seconds": "60",
        "transcription_max_audio_bytes": "1024",
    } | overrides


def test_transcription_posts_typed_word_multipart_without_manual_content_type(
    tmp_path,
):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")
    seen = {}

    async def handler(request: httpx.Request):
        seen["url"] = str(request.url)
        seen["authorization"] = request.headers["Authorization"]
        seen["content_type"] = request.headers["Content-Type"]
        seen["body"] = await request.aread()
        return httpx.Response(
            200,
            headers={"X-Request-Id": "request-7"},
            json={
                "text": "甲乙",
                "language": "zh",
                "words": [
                    {"word": "甲", "start": 0, "end": 0.3},
                    {"word": "乙", "start": 0.3, "end": 0.6},
                ],
            },
        )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            return await transcribe_audio_words(
                audio,
                _runtime(),
                duration=0.6,
                client=client,
            )

    result = asyncio.run(run())

    assert seen["url"] == "https://speech.example/v1/audio/transcriptions"
    assert seen["authorization"] == "Bearer secret-value"
    assert seen["content_type"].startswith("multipart/form-data; boundary=")
    assert b'name="model"' in seen["body"]
    assert b"whisper-1" in seen["body"]
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
    assert result.request_id == "request-7"


@pytest.mark.parametrize(
    ("runtime", "duration", "message"),
    [
        (
            _runtime(transcription_max_audio_bytes="3"),
            0.6,
            "大小超过",
        ),
        (
            _runtime(transcription_max_duration_seconds="0.5"),
            0.6,
            "时长超过",
        ),
    ],
)
def test_provider_limits_fail_before_any_paid_request(
    tmp_path,
    runtime,
    duration,
    message,
):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")
    calls = 0

    async def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            with pytest.raises(TranscriptionError, match=message) as captured:
                await transcribe_audio_words(
                    audio,
                    runtime,
                    duration=duration,
                    client=client,
                )
            assert captured.value.retryable is False

    asyncio.run(run())
    assert calls == 0


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"transcription_base_url": "speech.example/v1"}, "base_url"),
        ({"transcription_base_url": "ftp://speech.example/v1"}, "base_url"),
        ({"transcription_base_url": "https:///v1"}, "base_url"),
        (
            {"transcription_base_url": "https://speech.example:abc/v1"},
            "base_url",
        ),
        (
            {"transcription_base_url": "https://speech.example:70000/v1"},
            "base_url",
        ),
        (
            {"transcription_base_url": "https://speech example/v1"},
            "base_url",
        ),
        (
            {"transcription_base_url": " https://speech.example/v1"},
            "base_url",
        ),
        ({"transcription_base_url": "https:// /v1"}, "base_url"),
        ({"transcription_max_audio_bytes": "0.5"}, "max_audio_bytes"),
        ({"transcription_max_audio_bytes": "3.5"}, "max_audio_bytes"),
        ({"transcription_max_audio_bytes": "0"}, "max_audio_bytes"),
        ({"transcription_max_audio_bytes": "-1"}, "max_audio_bytes"),
        ({"transcription_max_audio_bytes": True}, "max_audio_bytes"),
    ],
)
def test_invalid_provider_url_and_byte_limit_fail_before_paid_request(
    tmp_path,
    overrides,
    message,
):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"x")
    calls = 0

    async def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={
            "words": [{"word": "甲", "start": 0, "end": 0.1}],
        })

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            with pytest.raises(TranscriptionError, match=message) as captured:
                await transcribe_audio_words(
                    audio,
                    _runtime(**overrides),
                    duration=0.1,
                    client=client,
                )
            assert captured.value.retryable is False

    asyncio.run(run())
    assert calls == 0


@pytest.mark.parametrize(
    ("status", "retryable"),
    [
        (400, False),
        (401, False),
        (403, False),
        (404, False),
        (413, False),
        (422, False),
        (418, False),
        (408, True),
        (409, True),
        (425, True),
        (429, True),
        (500, True),
        (503, True),
    ],
)
def test_transcription_http_failures_have_explicit_retryability(
    tmp_path,
    status,
    retryable,
):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")

    async def handler(_request: httpx.Request):
        return httpx.Response(status, text="secret-value must not leak")

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            with pytest.raises(TranscriptionError) as captured:
                await transcribe_audio_words(
                    audio,
                    _runtime(),
                    duration=0.6,
                    client=client,
                )
            assert captured.value.retryable is retryable
            assert "secret-value" not in str(captured.value)

    asyncio.run(run())


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"words": []},
        {"words": "甲"},
        {"words": [{"word": "", "start": 0, "end": 0.2}]},
        {"words": [{"word": "甲", "start": True, "end": 0.2}]},
        {"words": [{"word": "甲", "start": "0", "end": 0.2}]},
        {"words": [{"word": "甲", "start": 0, "end": "0.2"}]},
        {"words": [{"word": "甲", "start": float("nan"), "end": 0.2}]},
        {"words": [{"word": "甲", "start": 0, "end": float("inf")}]},
        {"words": [{"word": "甲", "start": -0.1, "end": 0.2}]},
        {"words": [{"word": "甲", "start": 0.2, "end": 0.2}]},
        {
            "words": [
                {"word": "甲", "start": 0, "end": 0.4},
                {"word": "乙", "start": 0.3, "end": 0.5},
            ],
        },
        {"words": [{"word": "甲", "start": 0, "end": 0.7}]},
    ],
)
def test_transcription_rejects_missing_or_malformed_word_array(
    tmp_path,
    payload,
):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")

    async def handler(_request: httpx.Request):
        return httpx.Response(
            200,
            content=json.dumps(payload, allow_nan=True).encode(),
            headers={"Content-Type": "application/json"},
        )

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            with pytest.raises(TranscriptionError, match="words") as captured:
                await transcribe_audio_words(
                    audio,
                    _runtime(),
                    duration=0.6,
                    client=client,
                )
            assert captured.value.retryable is False

    asyncio.run(run())


def test_transcription_returns_only_canonical_validated_word_fields(tmp_path):
    audio = tmp_path / "master.mp3"
    audio.write_bytes(b"fake-mp3")

    async def handler(_request: httpx.Request):
        return httpx.Response(200, json={
            "words": [{
                "word": "甲",
                "start": 0,
                "end": 0.2,
                "provider_secret": "must-not-pass-through",
            }],
        })

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
        ) as client:
            return await transcribe_audio_words(
                audio,
                _runtime(),
                duration=0.6,
                client=client,
            )

    result = asyncio.run(run())

    assert result.words == ({
        "id": "provider-1",
        "text": "甲",
        "start": 0.0,
        "end": 0.2,
    },)

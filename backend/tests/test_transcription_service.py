import asyncio

import httpx

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


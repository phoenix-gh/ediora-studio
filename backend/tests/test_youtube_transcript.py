import json
from pathlib import Path

import pytest


VTT = """WEBVTT

00:00:01.000 --> 00:00:03.000
<c>Build agents</c>

00:00:02.000 --> 00:00:04.000
Build agents with tools

00:00:05.000 --> 00:00:07.000
with tools &amp; memory
"""


def test_parse_vtt_strips_tags_preserves_timestamps_and_collapses_rolling_text():
    from youtube_transcript import parse_vtt

    segments = parse_vtt(VTT)

    assert segments == [
        {"start": 1.0, "end": 3.0, "text": "Build agents"},
        {"start": 2.0, "end": 4.0, "text": "with tools"},
        {"start": 5.0, "end": 7.0, "text": "& memory"},
    ]


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "http://127.0.0.1/video",
    "http://localhost/video",
    "https://example.com/watch?v=abc",
    "https://youtube.com.evil.test/watch?v=abc",
])
def test_validate_youtube_url_rejects_untrusted_sources(url):
    from youtube_transcript import UnsafeVideoUrl, validate_youtube_url

    with pytest.raises(UnsafeVideoUrl):
        validate_youtube_url(url)


def test_caption_selection_prefers_manual_then_auto():
    from youtube_transcript import select_caption

    manual = {"en": [{"ext": "vtt", "url": "https://caption.test/manual"}]}
    automatic = {"en": [{"ext": "vtt", "url": "https://caption.test/auto"}]}

    assert select_caption(manual, automatic, "en") == (
        "manual", "en", "https://caption.test/manual",
    )
    assert select_caption({}, automatic, "en") == (
        "auto", "en", "https://caption.test/auto",
    )


def test_caption_selection_prefers_chinese_across_caption_sources():
    from youtube_transcript import select_caption

    manual = {"en-US": [{"ext": "vtt", "url": "https://caption.test/manual-en"}]}
    automatic = {
        "ab": [{"ext": "vtt", "url": "https://caption.test/auto-ab"}],
        "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/auto-zh"}],
    }

    assert select_caption(manual, automatic, "en-US") == (
        "auto", "zh-Hans", "https://caption.test/auto-zh",
    )


def test_caption_selection_falls_back_to_english_without_chinese():
    from youtube_transcript import select_caption

    manual = {"en-US": [{"ext": "vtt", "url": "https://caption.test/manual-en"}]}
    automatic = {"ab": [{"ext": "vtt", "url": "https://caption.test/auto-ab"}]}

    assert select_caption(manual, automatic, "ab") == (
        "manual", "en-US", "https://caption.test/manual-en",
    )


@pytest.mark.asyncio
async def test_extract_downloads_selected_chinese_caption_with_ytdlp(monkeypatch):
    from youtube_transcript import extract_youtube_transcript

    metadata = {
        "id": "video-id",
        "duration": 7,
        "language": "en",
        "subtitles": {"en": [{"ext": "vtt", "url": "https://caption.test/en"}]},
        "automatic_captions": {
            "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}],
        },
    }
    commands: list[tuple[str, ...]] = []

    async def command(*argv: str, timeout: float) -> str:
        commands.append(argv)
        if "--dump-single-json" in argv:
            return json.dumps(metadata)
        if "--write-auto-subs" in argv:
            template = argv[argv.index("-o") + 1]
            subtitle = Path(template.replace("%(id)s", "video-id").replace("%(ext)s", "vtt"))
            subtitle.write_text(VTT, encoding="utf-8")
            return ""
        raise AssertionError(f"unexpected command: {argv}")

    class DirectCaptionHttpClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            raise AssertionError("caption requests must be delegated to yt-dlp")

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr("youtube_transcript.httpx.AsyncClient", DirectCaptionHttpClient)

    result = await extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id", {}, command=command
    )

    assert result["source"] == "auto"
    assert result["language"] == "zh-Hans"
    assert result["text"] == "Build agents with tools & memory"
    assert commands[1][0:6] == (
        "yt-dlp", "--skip-download", "--write-auto-subs", "--sub-langs", "zh-Hans", "--sub-format",
    )


def test_transcript_result_has_stable_content_hash():
    from youtube_transcript import build_transcript

    first = build_transcript("manual", "en", [{"start": 0, "end": 1, "text": "Hello"}])
    second = build_transcript("manual", "en", [{"start": 0, "end": 2, "text": "Hello"}])

    assert first["text"] == "Hello"
    assert first["content_hash"] == second["content_hash"]


@pytest.mark.asyncio
async def test_official_caption_url_survives_dns_proxy_fake_ip(monkeypatch):
    from youtube_transcript import _ensure_public_http_url

    def should_not_resolve(*_args, **_kwargs):
        raise AssertionError("official YouTube caption hosts must use the allowlist")

    monkeypatch.setattr("youtube_transcript.socket.getaddrinfo", should_not_resolve)

    await _ensure_public_http_url(
        "https://www.youtube.com/api/timedtext?v=video&lang=en"
    )

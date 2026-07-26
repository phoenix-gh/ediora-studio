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

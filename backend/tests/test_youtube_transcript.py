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
NETSCAPE_COOKIES = """# Netscape HTTP Cookie File
.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tyoutube-secret
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


def test_original_caption_selection_prefers_video_language_manual_then_auto():
    from youtube_transcript import select_original_caption

    manual = {"en": [{"ext": "vtt", "url": "https://caption.test/manual"}]}
    automatic = {"en": [{"ext": "vtt", "url": "https://caption.test/auto"}]}

    assert select_original_caption(manual, automatic, "en") == (
        "manual", "en", "https://caption.test/manual",
    )
    assert select_original_caption({}, automatic, "en") == (
        "auto", "en", "https://caption.test/auto",
    )


def test_original_caption_selection_does_not_replace_english_with_chinese():
    from youtube_transcript import select_original_caption

    manual = {"en-US": [{"ext": "vtt", "url": "https://caption.test/manual-en"}]}
    automatic = {
        "ab": [{"ext": "vtt", "url": "https://caption.test/auto-ab"}],
        "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/auto-zh"}],
    }

    assert select_original_caption(manual, automatic, "en-US") == (
        "manual", "en-US", "https://caption.test/manual-en",
    )


def test_chinese_caption_selection_is_independent_and_manual_first():
    from youtube_transcript import select_chinese_caption

    manual = {"zh-Hant": [{"ext": "vtt", "url": "https://caption.test/manual-zh"}]}
    automatic = {"zh-Hans": [{"ext": "vtt", "url": "https://caption.test/auto-zh"}]}

    assert select_chinese_caption(manual, automatic) == (
        "manual", "zh-Hant", "https://caption.test/manual-zh",
    )


@pytest.mark.parametrize("language", ["zh", "zh-Hans", "cmn", "yue"])
def test_chinese_language_aliases_are_recognized(language):
    from youtube_transcript import _is_chinese_caption

    assert _is_chinese_caption(language)


def test_missing_original_language_does_not_select_an_arbitrary_translation():
    from youtube_transcript import select_original_caption

    manual = {
        "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}],
        "es": [{"ext": "vtt", "url": "https://caption.test/es"}],
    }

    assert select_original_caption(manual, {}, "") is None


@pytest.mark.asyncio
async def test_extract_downloads_original_and_chinese_captions_with_ytdlp(monkeypatch):
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
        if "--write-subs" in argv or "--write-auto-subs" in argv:
            template = argv[argv.index("-o") + 1]
            subtitle = Path(template.replace("%(id)s", "video-id").replace("%(ext)s", "vtt"))
            language = argv[argv.index("--sub-langs") + 1]
            subtitle.write_text(VTT.replace("Build agents", f"{language} text"), encoding="utf-8")
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

    assert result["source"] == "manual"
    assert result["language"] == "en"
    assert result["text"].startswith("en text")
    assert result["chinese"]["source"] == "auto"
    assert result["chinese"]["language"] == "zh-Hans"
    assert result["chinese"]["text"].startswith("zh-Hans text")
    assert commands[1][0:2] == ("yt-dlp", "--skip-download")
    assert "--ignore-no-formats-error" in commands[1]
    assert commands[1][commands[1].index("--sub-langs") + 1] == "en"
    assert commands[2][commands[2].index("--sub-langs") + 1] == "zh-Hans"
    assert all("--cookies" not in command for command in commands)


@pytest.mark.asyncio
async def test_extract_passes_one_temporary_cookie_file_to_metadata_and_subtitles():
    from youtube_transcript import extract_youtube_transcript

    metadata = {
        "id": "video-id",
        "duration": 7,
        "language": "zh-Hans",
        "automatic_captions": {
            "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}],
        },
    }
    commands: list[tuple[str, ...]] = []
    cookie_paths: list[Path] = []

    async def command(*argv: str, timeout: float) -> str:
        commands.append(argv)
        cookie_path = Path(argv[argv.index("--cookies") + 1])
        cookie_paths.append(cookie_path)
        assert cookie_path.read_text(encoding="utf-8") == NETSCAPE_COOKIES
        if "--dump-single-json" in argv:
            return json.dumps(metadata)
        template = argv[argv.index("-o") + 1]
        subtitle = Path(template.replace("%(id)s", "video-id").replace("%(ext)s", "vtt"))
        subtitle.write_text(VTT, encoding="utf-8")
        return ""

    result = await extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id",
        {"youtube_cookies": NETSCAPE_COOKIES},
        command=command,
    )

    assert result["language"] == "zh-Hans"
    assert "chinese" not in result
    assert len(commands) == 2
    assert len(set(cookie_paths)) == 1
    assert "--ignore-no-formats-error" in commands[0]
    assert "--ignore-no-formats-error" in commands[1]
    assert not cookie_paths[0].exists()


@pytest.mark.asyncio
async def test_extract_passes_cookie_file_to_audio_fallback(monkeypatch):
    import youtube_transcript

    commands: list[tuple[str, ...]] = []

    async def command(*argv: str, timeout: float) -> str:
        commands.append(argv)
        cookie_path = Path(argv[argv.index("--cookies") + 1])
        assert cookie_path.read_text(encoding="utf-8") == NETSCAPE_COOKIES
        if "--dump-single-json" in argv:
            return json.dumps({"id": "video-id", "duration": 7})
        template = argv[argv.index("-o") + 1]
        Path(template.replace("%(ext)s", "mp3")).write_bytes(b"audio")
        return ""

    async def transcribe(
        _audio: Path,
        _config: dict[str, str],
        *,
        duration: float,
    ):
        assert duration == 7
        return {"source": "whisper", "language": "en", "text": "Audio transcript", "segments": []}

    monkeypatch.setattr(youtube_transcript, "_transcribe_audio", transcribe)

    result = await youtube_transcript.extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id",
        {"youtube_cookies": NETSCAPE_COOKIES},
        command=command,
    )

    assert result["source"] == "whisper"
    assert len(commands) == 2
    assert all("--cookies" in command for command in commands)


@pytest.mark.asyncio
async def test_audio_original_fallback_still_collects_available_chinese_caption(monkeypatch):
    import youtube_transcript

    metadata = {
        "id": "video-id",
        "duration": 7,
        "language": "ja",
        "automatic_captions": {
            "zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}],
        },
    }

    async def command(*argv: str, timeout: float) -> str:
        if "--dump-single-json" in argv:
            return json.dumps(metadata)
        template = argv[argv.index("-o") + 1]
        if "--write-auto-subs" in argv:
            Path(template.replace("%(id)s", "video-id").replace("%(ext)s", "vtt")).write_text(
                VTT, encoding="utf-8"
            )
        else:
            Path(template.replace("%(ext)s", "mp3")).write_bytes(b"audio")
        return ""

    async def transcribe(_audio, _config, *, duration):
        return {
            "source": "whisper",
            "language": "ja",
            "text": "original audio",
            "segments": [{"start": 0, "end": 1, "text": "original audio"}],
            "content_hash": "original-hash",
        }

    monkeypatch.setattr(youtube_transcript, "_transcribe_audio", transcribe)

    result = await youtube_transcript.extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id", {}, command=command
    )

    assert result["text"] == "original audio"
    assert result["chinese"]["language"] == "zh-Hans"
    assert result["chinese"]["text"] == "Build agents with tools & memory"


@pytest.mark.asyncio
async def test_chinese_caption_failure_does_not_discard_valid_original():
    from youtube_transcript import TranscriptError, extract_youtube_transcript

    metadata = {
        "id": "video-id",
        "duration": 7,
        "language": "en",
        "subtitles": {"en": [{"ext": "vtt", "url": "https://caption.test/en"}]},
        "automatic_captions": {"zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}]},
    }

    async def command(*argv: str, timeout: float) -> str:
        if "--dump-single-json" in argv:
            return json.dumps(metadata)
        language = argv[argv.index("--sub-langs") + 1]
        if language == "zh-Hans":
            raise TranscriptError("caption_download_failed", "中文下载失败", retryable=True)
        template = argv[argv.index("-o") + 1]
        Path(template.replace("%(id)s", "video-id").replace("%(ext)s", "vtt")).write_text(
            VTT, encoding="utf-8"
        )
        return ""

    result = await extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id", {}, command=command
    )

    assert result["language"] == "en"
    assert result["text"] == "Build agents with tools & memory"
    assert "chinese" not in result


@pytest.mark.asyncio
async def test_declared_chinese_original_does_not_duplicate_after_audio_fallback(monkeypatch):
    import youtube_transcript

    metadata = {
        "id": "video-id",
        "duration": 7,
        "original_language": "cmn",
        "automatic_captions": {"zh-Hans": [{"ext": "vtt", "url": "https://caption.test/zh"}]},
    }

    commands: list[tuple[str, ...]] = []

    async def command(*argv: str, timeout: float) -> str:
        commands.append(argv)
        if "--dump-single-json" in argv:
            return json.dumps(metadata)
        template = argv[argv.index("-o") + 1]
        Path(template.replace("%(ext)s", "mp3")).write_bytes(b"audio")
        return ""

    async def transcribe(_audio, _config, *, duration):
        return {"source": "whisper", "language": "en", "text": "中文原声", "segments": []}

    monkeypatch.setattr(youtube_transcript, "_transcribe_audio", transcribe)
    result = await youtube_transcript.extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id", {}, command=command
    )

    assert "chinese" not in result
    assert all("--write-auto-subs" not in argv for argv in commands)


@pytest.mark.asyncio
async def test_audio_fallback_uses_shared_transcription_segments(monkeypatch):
    """Catches YouTube bypassing the selected local transcription provider."""
    import youtube_transcript
    from transcription_service import (
        TranscriptSegment,
        TranscriptionResult,
    )

    async def command(*argv: str, timeout: float) -> str:
        if "--dump-single-json" in argv:
            return json.dumps({
                "id": "video-id",
                "duration": 7,
                "subtitles": {},
                "automatic_captions": {},
            })
        template = argv[argv.index("-o") + 1]
        Path(template.replace("%(ext)s", "mp3")).write_bytes(b"audio")
        return ""

    async def transcribe(request, _config):
        assert request.duration == 7
        assert request.require_word_timestamps is False
        return TranscriptionResult(
            words=(),
            segments=(
                TranscriptSegment(
                    text="本地字幕",
                    start=0.2,
                    end=1.4,
                ),
            ),
            text="本地字幕",
            language="zh",
            request_id="local-youtube-1",
        )

    monkeypatch.setattr(
        youtube_transcript,
        "transcribe_audio",
        transcribe,
        raising=False,
    )

    result = await youtube_transcript.extract_youtube_transcript(
        "https://www.youtube.com/watch?v=video-id",
        {"transcription_provider": "local-whisper"},
        command=command,
    )

    assert result["source"] == "whisper"
    assert result["language"] == "zh"
    assert result["text"] == "本地字幕"
    assert result["segments"] == [
        {"start": 0.2, "end": 1.4, "text": "本地字幕"},
    ]


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

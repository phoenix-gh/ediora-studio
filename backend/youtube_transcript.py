"""Caption-first YouTube transcript extraction with bounded audio fallback."""

from __future__ import annotations

import asyncio
import hashlib
import html
import ipaddress
import json
import re
import socket
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator
from urllib.parse import urlparse

import httpx

from transcription_service import (
    TranscriptionError,
    TranscriptionRequest,
    transcribe_audio,
)


class TranscriptError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class UnsafeVideoUrl(TranscriptError):
    def __init__(self, message: str = "视频地址不受支持"):
        super().__init__("source_not_found", message)


_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
_YOUTUBE_MEDIA_DOMAINS = {"youtube.com", "googlevideo.com"}
_TIMING = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+"
    r"(?P<end>\d{2}:\d{2}:\d{2}\.\d{3})"
)
_TAGS = re.compile(r"<[^>]+>")
_SENTENCE_END_CHARS = "。！？.!?…⋯｡．﹒︒﹖︖﹗︕"
_SENTENCE_END_CLASS = re.escape(_SENTENCE_END_CHARS)
_SENTENCE_PARTS = re.compile(
    rf".*?[{_SENTENCE_END_CLASS}]+[\"'”’」』】）)]*",
    re.DOTALL,
)
_SENTENCE_END = re.compile(rf"[{_SENTENCE_END_CLASS}]+[\"'”’」』】）)]*$")
_CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
_NO_SPACE_BEFORE = re.compile(
    rf"^[,;:，；：、）】》」』”’{_SENTENCE_END_CLASS}]"
)
_NO_SPACE_AFTER = re.compile(r"[（【《「『“‘]$")
_MAX_SENTENCE_SECONDS = 15.0
_MAX_CHINESE_CHARS = 60
_MAX_OTHER_CHARS = 140
_SILENCE_BREAK_SECONDS = 1.0


def validate_youtube_url(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or host not in _YOUTUBE_HOSTS:
        raise UnsafeVideoUrl()
    return url


def _seconds(value: str) -> float:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(".")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def _clean_text(value: str) -> str:
    value = html.unescape(_TAGS.sub("", value))
    return re.sub(r"\s+", " ", value).strip()


def _new_rolling_text(previous: str, current: str) -> str:
    if not previous:
        return current
    previous_words = previous.split()
    current_words = current.split()
    if current_words[: len(previous_words)] == previous_words:
        return " ".join(current_words[len(previous_words):])
    max_overlap = min(len(previous_words), len(current_words))
    for size in range(max_overlap, 0, -1):
        if previous_words[-size:] == current_words[:size]:
            return " ".join(current_words[size:])
    return current


def parse_vtt(value: str) -> list[dict[str, float | str]]:
    """Normalize VTT cues and remove YouTube rolling-caption repetition."""
    lines = value.replace("\ufeff", "").replace("\r\n", "\n").split("\n")
    result: list[dict[str, float | str]] = []
    previous_raw = ""
    index = 0
    while index < len(lines):
        match = _TIMING.search(lines[index])
        if not match:
            index += 1
            continue
        index += 1
        cue_lines: list[str] = []
        while index < len(lines) and lines[index].strip():
            cue_lines.append(lines[index])
            index += 1
        raw = _clean_text(" ".join(cue_lines))
        emitted = _new_rolling_text(previous_raw, raw)
        previous_raw = raw or previous_raw
        if emitted:
            result.append({
                "start": _seconds(match.group("start")),
                "end": _seconds(match.group("end")),
                "text": emitted,
            })
        index += 1
    return result


def _join_sentence_text(previous: str, current: str) -> str:
    if not previous:
        return current
    if not current:
        return previous
    if (
        _CJK.search(previous[-1])
        or _CJK.search(current[0])
        or _NO_SPACE_BEFORE.search(current)
        or _NO_SPACE_AFTER.search(previous)
    ):
        return f"{previous}{current}"
    return f"{previous} {current}"


def _split_sentence_parts(value: str) -> list[str]:
    parts: list[str] = []
    offset = 0
    for match in _SENTENCE_PARTS.finditer(value):
        part = match.group(0).strip()
        if part:
            parts.append(part)
        offset = match.end()
    remainder = value[offset:].strip()
    if remainder:
        parts.append(remainder)
    return parts


def _sentence_segments(
    language: str,
    segments: list[dict],
) -> list[dict[str, float | str]]:
    result: list[dict[str, float | str]] = []
    text = ""
    start = 0.0
    end = 0.0
    max_chars = _MAX_CHINESE_CHARS if _is_chinese_caption(language) else _MAX_OTHER_CHARS

    def flush() -> None:
        nonlocal text, start, end
        if text:
            result.append({"start": start, "end": end, "text": text})
        text = ""
        start = 0.0
        end = 0.0

    for segment in segments:
        source_text = _clean_text(str(segment.get("text") or ""))
        if not source_text:
            continue
        segment_start = float(segment.get("start") or 0)
        segment_end = float(segment.get("end") or segment_start)
        combined = _join_sentence_text(text, source_text)
        if text and (
            segment_start - end > _SILENCE_BREAK_SECONDS
            or segment_end - start > _MAX_SENTENCE_SECONDS
            or len(combined) > max_chars
        ):
            flush()

        for part in _split_sentence_parts(source_text):
            if not text:
                start = segment_start
            text = _join_sentence_text(text, part)
            end = segment_end
            if _SENTENCE_END.search(part):
                flush()

    flush()
    return result


def build_transcript(source: str, language: str, segments: list[dict]) -> dict[str, Any]:
    normalized_segments = _sentence_segments(language, segments)
    normalized = "\n".join(str(segment["text"]) for segment in normalized_segments)
    return {
        "source": source,
        "language": language,
        "text": normalized,
        "segments": normalized_segments,
        "content_hash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
    }


def _caption_url(formats: list[dict]) -> str:
    for item in formats or []:
        if item.get("ext") == "vtt" and item.get("url"):
            return str(item["url"])
    for item in formats or []:
        if item.get("url"):
            return str(item["url"])
    return ""


def _is_chinese_caption(language: str) -> bool:
    base = language.lower().replace("_", "-").split("-", 1)[0]
    return base in {"zh", "cmn", "yue"}


def _is_english_caption(language: str) -> bool:
    return language.lower().replace("_", "-").startswith("en")


def _matching_languages(collection: dict[str, list[dict]], preferred_language: str) -> list[str]:
    preferred = preferred_language.lower().replace("_", "-")
    exact = [language for language in collection if language.lower().replace("_", "-") == preferred]
    if exact:
        return exact
    base = preferred.split("-", 1)[0]
    return [
        language for language in collection
        if language.lower().replace("_", "-").split("-", 1)[0] == base
    ]


def select_original_caption(
    manual: dict[str, list[dict]],
    automatic: dict[str, list[dict]],
    preferred_language: str = "",
) -> tuple[str, str, str] | None:
    if not preferred_language:
        return None
    for source, collection in (("manual", manual), ("auto", automatic)):
        languages = _matching_languages(collection, preferred_language)
        for language in languages:
            url = _caption_url(collection.get(language, []))
            if url:
                return source, language, url
    return None


def select_chinese_caption(
    manual: dict[str, list[dict]],
    automatic: dict[str, list[dict]],
) -> tuple[str, str, str] | None:
    for source, collection in (("manual", manual), ("auto", automatic)):
        for language, formats in collection.items():
            if _is_chinese_caption(language):
                url = _caption_url(formats)
                if url:
                    return source, language, url
    return None


# Compatibility for callers outside this module. New extraction uses the explicit selectors.
select_caption = select_original_caption


async def _ensure_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise TranscriptError("caption_download_failed", "字幕地址不受支持")
    host = parsed.hostname.lower().rstrip(".")
    if any(
        host == domain or host.endswith(f".{domain}")
        for domain in _YOUTUBE_MEDIA_DOMAINS
    ):
        # DNS proxy/TUN setups commonly return RFC 2544 fake IPs for public
        # hosts. Exact HTTPS domain allowlisting avoids that false positive
        # without opening the caption fetcher to arbitrary private hosts.
        return
    try:
        addresses = await asyncio.to_thread(
            socket.getaddrinfo, host, parsed.port or 443, type=socket.SOCK_STREAM
        )
    except OSError as exc:
        raise TranscriptError("caption_download_failed", "字幕地址解析失败", retryable=True) from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise TranscriptError("caption_download_failed", "字幕地址指向本地网络")


async def run_command(*argv: str, timeout: float = 120) -> str:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise TranscriptError("caption_download_failed", "媒体处理超时", retryable=True) from exc
    if process.returncode:
        safe = stderr.decode("utf-8", "replace").splitlines()[-1:] or ["媒体处理失败"]
        raise TranscriptError("caption_download_failed", safe[0][:300], retryable=True)
    return stdout.decode("utf-8", "replace")


async def _transcribe_audio(
    audio_path: Path,
    config: dict[str, str],
    *,
    duration: float,
) -> dict[str, Any]:
    try:
        result = await transcribe_audio(
            TranscriptionRequest(
                audio_path=audio_path,
                duration=duration,
                require_word_timestamps=False,
            ),
            config,
        )
    except TranscriptionError as exc:
        raise TranscriptError(
            "transcription_failed",
            str(exc),
            retryable=exc.retryable,
        ) from exc
    segments = [
        {
            "start": item.start,
            "end": item.end,
            "text": _clean_text(item.text),
        }
        for item in result.segments
        if item.text.strip()
    ]
    if not segments:
        raise TranscriptError(
            "transcription_failed",
            "语音转写未返回有效分段",
        )
    return build_transcript("whisper", result.language, segments)


@contextmanager
def youtube_cookies_file(cookies: str) -> Iterator[str | None]:
    if not cookies.strip():
        yield None
        return
    with tempfile.TemporaryDirectory(prefix="wms-youtube-cookies-") as directory:
        path = Path(directory) / "cookies.txt"
        path.write_text(cookies, encoding="utf-8")
        path.chmod(0o600)
        yield str(path)


def ytdlp_argv(*args: str, cookie_path: str | None, url: str) -> tuple[str, ...]:
    return (
        "yt-dlp",
        *args,
        *(("--cookies", cookie_path) if cookie_path else ()),
        url,
    )


async def extract_youtube_transcript(
    url: str,
    config: dict[str, str],
    *,
    command: Callable[..., Awaitable[str]] = run_command,
) -> dict[str, Any]:
    """Extract subtitles, falling back to a bounded audio-only transcription."""
    validate_youtube_url(url)
    with youtube_cookies_file(config.get("youtube_cookies", "")) as cookie_path:
        metadata_raw = await command(
            *ytdlp_argv(
                "--dump-single-json", "--skip-download", "--ignore-no-formats-error", "--no-playlist",
                cookie_path=cookie_path,
                url=url,
            ),
            timeout=60,
        )
        try:
            metadata = json.loads(metadata_raw)
        except ValueError as exc:
            raise TranscriptError("source_not_found", "无法读取视频信息", retryable=True) from exc
        max_duration = int(config.get("transcription_max_duration_seconds", "7200"))
        video_duration = float(metadata.get("duration") or 0)
        if video_duration > max_duration:
            raise TranscriptError("video_too_long", "视频时长超过转写上限")
        preferred = str(metadata.get("language") or metadata.get("original_language") or "")
        video_original_is_chinese = _is_chinese_caption(preferred)
        manual = metadata.get("subtitles") or {}
        automatic = metadata.get("automatic_captions") or {}
        caption = select_original_caption(manual, automatic, preferred)

        async def download_caption(selected: tuple[str, str, str]) -> dict[str, Any]:
            source, language, _caption_url = selected
            with tempfile.TemporaryDirectory(prefix="wms-youtube-captions-") as directory:
                template = str(Path(directory) / "%(id)s.%(ext)s")
                await command(
                    *ytdlp_argv(
                        "--skip-download",
                        "--ignore-no-formats-error",
                        "--write-subs" if source == "manual" else "--write-auto-subs",
                        "--sub-langs", language,
                        "--sub-format", "vtt",
                        "-o", template,
                        cookie_path=cookie_path,
                        url=url,
                    ),
                    timeout=120,
                )
                subtitle_files = list(Path(directory).glob("*.vtt"))
                if not subtitle_files:
                    raise TranscriptError("caption_download_failed", "未能取得字幕文件", retryable=True)
                segments = parse_vtt(subtitle_files[0].read_text(encoding="utf-8", errors="replace"))
                if segments:
                    return build_transcript(source, language, segments)
                raise TranscriptError("caption_download_failed", "字幕文件内容为空", retryable=True)

        if caption:
            original = await download_caption(caption)
            if not video_original_is_chinese and not _is_chinese_caption(original["language"]):
                chinese_caption = select_chinese_caption(manual, automatic)
                if chinese_caption:
                    try:
                        original["chinese"] = await download_caption(chinese_caption)
                    except Exception:
                        pass
            return original

        max_bytes = int(config.get("transcription_max_audio_bytes", str(25 * 1024 * 1024)))
        with tempfile.TemporaryDirectory(prefix="wms-youtube-") as directory:
            template = str(Path(directory) / "audio.%(ext)s")
            await command(
                *ytdlp_argv(
                    "--no-playlist", "-x", "--audio-format", "mp3",
                    "--audio-quality", "7", "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000",
                    "-o", template,
                    cookie_path=cookie_path,
                    url=url,
                ),
                timeout=300,
            )
            files = list(Path(directory).glob("audio.*"))
            if not files:
                raise TranscriptError("audio_download_failed", "未能取得视频音频", retryable=True)
            audio = files[0]
            if audio.stat().st_size > max_bytes:
                raise TranscriptError("audio_too_large", "压缩音频超过转写上限")
            original = await _transcribe_audio(
                audio,
                config,
                duration=video_duration,
            )
            if not video_original_is_chinese and not _is_chinese_caption(str(original.get("language") or "")):
                chinese_caption = select_chinese_caption(manual, automatic)
                if chinese_caption:
                    try:
                        original["chinese"] = await download_caption(chinese_caption)
                    except Exception:
                        pass
            return original

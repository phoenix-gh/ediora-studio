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
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

import httpx


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


def build_transcript(source: str, language: str, segments: list[dict]) -> dict[str, Any]:
    text = " ".join(str(segment.get("text") or "").strip() for segment in segments).strip()
    normalized = re.sub(r"\s+", " ", text)
    return {
        "source": source,
        "language": language,
        "text": normalized,
        "segments": segments,
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
    return language.lower().replace("_", "-").startswith("zh")


def _is_english_caption(language: str) -> bool:
    return language.lower().replace("_", "-").startswith("en")


def select_caption(
    manual: dict[str, list[dict]],
    automatic: dict[str, list[dict]],
    preferred_language: str = "",
) -> tuple[str, str, str] | None:
    collections = (("manual", manual), ("auto", automatic))
    for predicate in (_is_chinese_caption, _is_english_caption):
        for source, collection in collections:
            for language, formats in collection.items():
                if predicate(language):
                    url = _caption_url(formats)
                    if url:
                        return source, language, url
    for source, collection in collections:
        languages = ([preferred_language] if preferred_language in collection else []) + [
            language for language in collection if language != preferred_language
        ]
        for language in languages:
            url = _caption_url(collection.get(language, []))
            if url:
                return source, language, url
    return None


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


async def _transcribe_audio(audio_path: Path, config: dict[str, str]) -> dict[str, Any]:
    api_key = config.get("transcription_api_key", "").strip()
    base_url = config.get("transcription_base_url", "").strip().rstrip("/")
    model = config.get("transcription_model", "").strip() or "whisper-1"
    if not api_key or not base_url:
        raise TranscriptError("transcription_failed", "语音转写服务尚未配置")
    try:
        async with httpx.AsyncClient(timeout=180, follow_redirects=False) as client:
            with audio_path.open("rb") as handle:
                response = await client.post(
                    f"{base_url}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    data={"model": model, "response_format": "verbose_json"},
                    files={"file": (audio_path.name, handle, "audio/mpeg")},
                )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise TranscriptError("transcription_failed", "语音转写服务调用失败", retryable=True) from exc
    segments = [{
        "start": float(segment.get("start", 0)),
        "end": float(segment.get("end", 0)),
        "text": _clean_text(str(segment.get("text") or "")),
    } for segment in payload.get("segments", []) if str(segment.get("text") or "").strip()]
    if not segments and payload.get("text"):
        segments = [{"start": 0.0, "end": 0.0, "text": _clean_text(str(payload["text"]))}]
    return build_transcript("whisper", str(payload.get("language") or ""), segments)


async def extract_youtube_transcript(
    url: str,
    config: dict[str, str],
    *,
    command: Callable[..., Awaitable[str]] = run_command,
) -> dict[str, Any]:
    """Extract subtitles, falling back to a bounded audio-only transcription."""
    validate_youtube_url(url)
    metadata_raw = await command(
        "yt-dlp", "--dump-single-json", "--skip-download", "--no-playlist", url,
        timeout=60,
    )
    try:
        metadata = json.loads(metadata_raw)
    except ValueError as exc:
        raise TranscriptError("source_not_found", "无法读取视频信息", retryable=True) from exc
    max_duration = int(config.get("transcription_max_duration_seconds", "7200"))
    if float(metadata.get("duration") or 0) > max_duration:
        raise TranscriptError("video_too_long", "视频时长超过转写上限")
    preferred = str(metadata.get("language") or metadata.get("original_language") or "")
    caption = select_caption(
        metadata.get("subtitles") or {},
        metadata.get("automatic_captions") or {},
        preferred,
    )
    if caption:
        source, language, _caption_url = caption
        with tempfile.TemporaryDirectory(prefix="wms-youtube-captions-") as directory:
            template = str(Path(directory) / "%(id)s.%(ext)s")
            await command(
                "yt-dlp", "--skip-download",
                "--write-subs" if source == "manual" else "--write-auto-subs",
                "--sub-langs", language,
                "--sub-format", "vtt",
                "-o", template,
                url,
                timeout=120,
            )
            subtitle_files = list(Path(directory).glob("*.vtt"))
            if not subtitle_files:
                raise TranscriptError("caption_download_failed", "未能取得字幕文件", retryable=True)
            segments = parse_vtt(subtitle_files[0].read_text(encoding="utf-8", errors="replace"))
            if segments:
                return build_transcript(source, language, segments)

    max_bytes = int(config.get("transcription_max_audio_bytes", str(25 * 1024 * 1024)))
    with tempfile.TemporaryDirectory(prefix="wms-youtube-") as directory:
        template = str(Path(directory) / "audio.%(ext)s")
        await command(
            "yt-dlp", "--no-playlist", "-x", "--audio-format", "mp3",
            "--audio-quality", "7", "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000",
            "-o", template, url, timeout=300,
        )
        files = list(Path(directory).glob("audio.*"))
        if not files:
            raise TranscriptError("audio_download_failed", "未能取得视频音频", retryable=True)
        audio = files[0]
        if audio.stat().st_size > max_bytes:
            raise TranscriptError("audio_too_large", "压缩音频超过转写上限")
        return await _transcribe_audio(audio, config)

"""Typed OpenAI-compatible word transcription for text-video masters."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import math
from pathlib import Path
from typing import AsyncIterator, Mapping
from urllib.parse import urlsplit

import httpx

from text_video_alignment import AlignmentError, validate_word_timings


PERMANENT_HTTP_STATUSES = {400, 401, 403, 404, 413, 422}
RETRYABLE_HTTP_STATUSES = {408, 409, 425, 429}


class TranscriptionError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class TranscriptionResult:
    words: tuple[dict, ...]
    text: str
    language: str
    request_id: str


def _positive_number(
    config: Mapping[str, str],
    key: str,
    fallback: float,
) -> float:
    try:
        value = float(config.get(key, str(fallback)))
    except (TypeError, ValueError) as error:
        raise TranscriptionError(
            f"{key} 配置无效",
            retryable=False,
        ) from error
    if not math.isfinite(value) or value <= 0:
        raise TranscriptionError(f"{key} 配置无效", retryable=False)
    return value


def _positive_integer(
    config: Mapping[str, str],
    key: str,
    fallback: int,
) -> int:
    raw = config.get(key, str(fallback))
    if isinstance(raw, bool):
        raise TranscriptionError(f"{key} 配置无效", retryable=False)
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError) as error:
        raise TranscriptionError(
            f"{key} 配置无效",
            retryable=False,
        ) from error
    if str(raw).strip() != str(value) or value <= 0:
        raise TranscriptionError(f"{key} 配置无效", retryable=False)
    return value


def _validate_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        parsed.port
        strict = httpx.URL(value)
    except (ValueError, httpx.InvalidURL) as error:
        raise TranscriptionError(
            "transcription_base_url 配置无效",
            retryable=False,
        ) from error
    if (
        any(character.isspace() for character in value)
        or parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or strict.scheme not in {"http", "https"}
        or not strict.host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise TranscriptionError(
            "transcription_base_url 配置无效",
            retryable=False,
        )
    return value


def _retryable_status(status_code: int) -> bool:
    if status_code in PERMANENT_HTTP_STATUSES:
        return False
    return bool(
        status_code in RETRYABLE_HTTP_STATUSES
        or status_code >= 500
    )


@asynccontextmanager
async def _client_scope(
    client: httpx.AsyncClient | None,
) -> AsyncIterator[httpx.AsyncClient]:
    if client is not None:
        yield client
        return
    async with httpx.AsyncClient(
        timeout=180,
        follow_redirects=False,
    ) as owned:
        yield owned


async def transcribe_audio_words(
    audio_path: Path,
    config: Mapping[str, str],
    *,
    duration: float,
    client: httpx.AsyncClient | None = None,
) -> TranscriptionResult:
    provider = str(
        config.get("transcription_provider", "openai-compatible"),
    ).strip()
    model = str(config.get("transcription_model", "whisper-1")).strip()
    base_url = str(config.get("transcription_base_url", ""))
    api_key = str(config.get("transcription_api_key", "")).strip()
    if provider != "openai-compatible":
        raise TranscriptionError(
            f"不支持的语音转写供应商：{provider}",
            retryable=False,
        )
    if not model or not base_url or not api_key:
        raise TranscriptionError("语音转写服务尚未完整配置", retryable=False)
    base_url = _validate_base_url(base_url).rstrip("/")
    if (
        isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(float(duration))
        or duration <= 0
    ):
        raise TranscriptionError("主音频时长无效", retryable=False)
    max_duration = _positive_number(
        config,
        "transcription_max_duration_seconds",
        7200,
    )
    max_bytes = _positive_integer(
        config,
        "transcription_max_audio_bytes",
        25 * 1024 * 1024,
    )
    try:
        size = audio_path.stat().st_size
    except OSError as error:
        raise TranscriptionError(
            "主音频文件不存在或无法读取",
            retryable=False,
        ) from error
    if duration > max_duration:
        raise TranscriptionError(
            f"主音频时长超过转写服务限制（{max_duration:g} 秒）",
            retryable=False,
        )
    if size > max_bytes:
        raise TranscriptionError(
            f"主音频大小超过转写服务限制（{max_bytes} 字节）",
            retryable=False,
        )

    try:
        audio_bytes = await asyncio.to_thread(audio_path.read_bytes)
        async with _client_scope(client) as active_client:
            response = await active_client.post(
                f"{base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                data={
                    "model": model,
                    "response_format": "verbose_json",
                    "timestamp_granularities[]": "word",
                },
                files={
                    "file": (
                        audio_path.name,
                        audio_bytes,
                        "audio/mpeg",
                    ),
                },
            )
    except (httpx.TimeoutException, httpx.NetworkError) as error:
        raise TranscriptionError(
            "语音转写服务暂时无法访问",
            retryable=True,
        ) from error
    except httpx.HTTPError as error:
        raise TranscriptionError(
            "语音转写请求失败",
            retryable=True,
        ) from error
    if not response.is_success:
        raise TranscriptionError(
            f"语音转写服务返回 HTTP {response.status_code}",
            retryable=_retryable_status(response.status_code),
        )
    try:
        payload = response.json()
    except ValueError as error:
        raise TranscriptionError(
            "语音转写响应不是有效 JSON",
            retryable=False,
        ) from error
    if not isinstance(payload, dict):
        raise TranscriptionError(
            "语音转写响应不是对象",
            retryable=False,
        )
    words = payload.get("words")
    try:
        canonical_words = validate_word_timings(words, float(duration))
    except AlignmentError as error:
        raise TranscriptionError(
            f"语音转写 words 无效：{error}",
            retryable=False,
        ) from error
    return TranscriptionResult(
        words=tuple(canonical_words),
        text=str(payload.get("text") or ""),
        language=str(payload.get("language") or ""),
        request_id=str(
            response.headers.get("x-request-id")
            or response.headers.get("request-id")
            or ""
        )[:500],
    )

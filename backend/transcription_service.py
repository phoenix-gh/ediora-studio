"""Provider-neutral audio transcription with canonical timestamp validation."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import math
from pathlib import Path
from typing import AsyncIterator, Mapping
from urllib.parse import urlsplit
import uuid

import httpx

from local_asr_gate import (
    LocalAsrBusyError,
    LocalAsrLeaseLostError,
    local_asr_gate,
)
from runtime_config import get_runtime_settings
from text_video_alignment import AlignmentError, validate_word_timings


LOCAL_PROVIDER = "local-whisper"
OPENAI_COMPATIBLE_PROVIDER = "openai-compatible"
PERMANENT_HTTP_STATUSES = {400, 401, 403, 404, 413, 422}
RETRYABLE_HTTP_STATUSES = {408, 409, 425, 429}


class TranscriptionError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class TranscriptionRequest:
    audio_path: Path
    duration: float
    require_word_timestamps: bool = True
    language_hint: str | None = None


@dataclass(frozen=True)
class TranscriptSegment:
    text: str
    start: float
    end: float


@dataclass(frozen=True)
class TranscriptionResult:
    words: tuple[dict, ...]
    text: str
    language: str
    request_id: str
    segments: tuple[TranscriptSegment, ...] = ()


@dataclass(frozen=True)
class _ProviderConfig:
    base_url: str
    model: str
    api_key: str
    local: bool


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


def _provider_config(config: Mapping[str, str]) -> _ProviderConfig:
    provider = str(
        config.get("transcription_provider", LOCAL_PROVIDER),
    ).strip()
    if provider == LOCAL_PROVIDER:
        runtime = get_runtime_settings()
        return _ProviderConfig(
            base_url=_validate_base_url(runtime.local_asr_url).rstrip("/"),
            model=runtime.local_asr_model,
            api_key="",
            local=True,
        )
    if provider != OPENAI_COMPATIBLE_PROVIDER:
        raise TranscriptionError(
            f"不支持的语音转写供应商：{provider}",
            retryable=False,
        )
    model = str(config.get("transcription_model", "whisper-1")).strip()
    base_url = str(config.get("transcription_base_url", ""))
    api_key = str(config.get("transcription_api_key", "")).strip()
    if not model or not base_url or not api_key:
        raise TranscriptionError(
            "语音转写服务尚未完整配置",
            retryable=False,
        )
    return _ProviderConfig(
        base_url=_validate_base_url(base_url).rstrip("/"),
        model=model,
        api_key=api_key,
        local=False,
    )


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
    *,
    duration: float,
) -> AsyncIterator[httpx.AsyncClient]:
    if client is not None:
        yield client
        return
    timeout = max(180.0, min(3600.0, duration * 0.5 + 60.0))
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
    ) as owned:
        yield owned


def _nested_words(payload: dict) -> object:
    words = payload.get("words")
    if isinstance(words, list) and words:
        return words
    nested: list[object] = []
    segments = payload.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            segment_words = segment.get("words")
            if isinstance(segment_words, list):
                nested.extend(segment_words)
    return nested if nested else words


def _validate_segments(
    raw_segments: object,
    duration: float,
) -> tuple[TranscriptSegment, ...]:
    if raw_segments is None:
        return ()
    if not isinstance(raw_segments, list):
        raise TranscriptionError(
            "语音转写 segments 无效：必须是数组",
            retryable=False,
        )
    result: list[TranscriptSegment] = []
    previous_end = 0.0
    for index, raw in enumerate(raw_segments, start=1):
        if not isinstance(raw, dict):
            raise TranscriptionError(
                f"语音转写 segments 无效：第 {index} 项不是对象",
                retryable=False,
            )
        text = str(raw.get("text") or "").strip()
        start = raw.get("start")
        end = raw.get("end")
        if (
            not text
            or isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(float(start))
            or not math.isfinite(float(end))
            or float(start) < previous_end
            or float(start) < 0
            or float(end) <= float(start)
            or float(end) > duration
        ):
            raise TranscriptionError(
                f"语音转写 segments 无效：第 {index} 项时间或文本无效",
                retryable=False,
            )
        item = TranscriptSegment(
            text=text,
            start=float(start),
            end=float(end),
        )
        result.append(item)
        previous_end = item.end
    return tuple(result)


async def transcribe_audio(
    request: TranscriptionRequest,
    config: Mapping[str, str],
    *,
    client: httpx.AsyncClient | None = None,
) -> TranscriptionResult:
    provider = _provider_config(config)
    duration = request.duration
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
        size = request.audio_path.stat().st_size
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

    fields: dict[str, str] = {
        "model": provider.model,
        "response_format": "verbose_json",
    }
    if request.require_word_timestamps:
        fields["timestamp_granularities[]"] = "word"
    if request.language_hint:
        fields["language"] = request.language_hint
    if provider.local:
        fields["vad_filter"] = "true"
    headers = (
        {}
        if provider.local
        else {"Authorization": f"Bearer {provider.api_key}"}
    )
    try:
        audio_bytes = await asyncio.to_thread(request.audio_path.read_bytes)
        async def post() -> httpx.Response:
            async with _client_scope(
                client,
                duration=float(duration),
            ) as active:
                return await active.post(
                    f"{provider.base_url}/audio/transcriptions",
                    headers=headers,
                    data=fields,
                    files={
                        "file": (
                            request.audio_path.name,
                            audio_bytes,
                            "audio/mpeg",
                        ),
                    },
                )

        if provider.local and client is None:
            async with local_asr_gate(
                owner=f"asr-{uuid.uuid4().hex}",
            ):
                response = await post()
        else:
            response = await post()
    except (LocalAsrBusyError, LocalAsrLeaseLostError) as error:
        raise TranscriptionError(
            str(error),
            retryable=True,
        ) from error
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

    canonical_words: list[dict] = []
    raw_words = _nested_words(payload)
    if request.require_word_timestamps:
        try:
            canonical_words = validate_word_timings(
                raw_words,
                float(duration),
            )
        except AlignmentError as error:
            raise TranscriptionError(
                f"语音转写 words 无效：{error}",
                retryable=False,
            ) from error
    elif raw_words:
        try:
            canonical_words = validate_word_timings(
                raw_words,
                float(duration),
            )
        except AlignmentError:
            canonical_words = []

    return TranscriptionResult(
        words=tuple(canonical_words),
        segments=_validate_segments(
            payload.get("segments"),
            float(duration),
        ),
        text=str(payload.get("text") or ""),
        language=str(payload.get("language") or ""),
        request_id=str(
            response.headers.get("x-request-id")
            or response.headers.get("request-id")
            or ""
        )[:500],
    )

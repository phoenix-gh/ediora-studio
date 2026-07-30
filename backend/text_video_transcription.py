"""Compatibility boundary for text-video word transcription."""

from __future__ import annotations

from pathlib import Path
from typing import Mapping

import httpx

from transcription_service import (
    TranscriptionError,
    TranscriptionRequest,
    TranscriptionResult,
    transcribe_audio,
)


async def transcribe_audio_words(
    audio_path: Path,
    config: Mapping[str, str],
    *,
    duration: float,
    client: httpx.AsyncClient | None = None,
) -> TranscriptionResult:
    return await transcribe_audio(
        TranscriptionRequest(
            audio_path=audio_path,
            duration=duration,
            require_word_timestamps=True,
        ),
        config,
        client=client,
    )


__all__ = [
    "TranscriptionError",
    "TranscriptionResult",
    "transcribe_audio_words",
]

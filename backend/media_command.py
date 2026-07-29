"""Safe asynchronous subprocess helpers for local media tools."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
from typing import Sequence

from log_redaction import redact_secret_text


COMMON_SECRET = re.compile(
    r"(?i)((?:api[_-]?key|authorization|access[_-]?token|secret)"
    r"\s*[:=]\s*)(?:bearer\s+)?[^;\s,]+"
)


def _redact_media_text(value: str) -> str:
    return COMMON_SECRET.sub(r"\1***", redact_secret_text(value))


class MediaCommandError(RuntimeError):
    def __init__(
        self,
        command: Sequence[str],
        returncode: int | None,
        stderr: str,
        *,
        message: str | None = None,
    ):
        self.command = tuple(_redact_media_text(str(item)) for item in command)
        self.returncode = returncode
        self.redacted_stderr = _redact_media_text(stderr)[:4000]
        summary = message or (
            f"media command failed with exit code {returncode}"
        )
        if self.redacted_stderr:
            summary = f"{summary}: {self.redacted_stderr}"
        super().__init__(summary)


class MediaToolUnavailable(MediaCommandError):
    pass


@dataclass(frozen=True)
class AudioProbe:
    duration: float
    sample_rate: int
    channels: int
    codec_name: str
    bit_rate: int
    sample_count: int


async def _kill_and_reap(
    process: asyncio.subprocess.Process,
    communicate_task: asyncio.Task[tuple[bytes, bytes]],
) -> tuple[bytes, bytes]:
    if process.returncode is None:
        process.kill()
    try:
        return await communicate_task
    except asyncio.CancelledError:
        return await process.communicate()


async def run_media_command(
    args: Sequence[str],
    *,
    timeout: float = 120,
) -> bytes:
    command = [str(item) for item in args]
    if not command:
        raise ValueError("media command cannot be empty")
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as error:
        raise MediaToolUnavailable(
            command,
            None,
            "",
            message=f"{command[0]} is not installed or not on PATH",
        ) from error
    communicate_task = asyncio.create_task(process.communicate())
    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.shield(communicate_task),
            timeout=timeout,
        )
    except TimeoutError as error:
        _stdout, stderr = await _kill_and_reap(
            process,
            communicate_task,
        )
        raise MediaCommandError(
            command,
            process.returncode,
            stderr.decode("utf-8", errors="replace"),
            message=f"media command timed out after {timeout:g}s",
        ) from error
    except asyncio.CancelledError:
        await _kill_and_reap(process, communicate_task)
        raise
    if process.returncode != 0:
        raise MediaCommandError(
            command,
            process.returncode,
            stderr.decode("utf-8", errors="replace"),
        )
    return stdout


async def probe_audio(path: Path) -> AudioProbe:
    output = await run_media_command([
        "ffprobe",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_frames",
        "-show_entries",
        "stream=sample_rate,channels,codec_name,bit_rate:"
        "frame=nb_samples",
        "-of", "json",
        str(path),
    ])
    try:
        payload = json.loads(output)
        streams = payload["streams"]
        stream = streams[0]
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
        codec_name = str(stream["codec_name"])
        bit_rate_value = stream.get("bit_rate")
        bit_rate = (
            int(bit_rate_value)
            if bit_rate_value not in {None, "", "N/A"}
            else 0
        )
        sample_count = sum(
            int(frame["nb_samples"])
            for frame in payload.get("frames", [])
            if frame.get("nb_samples") not in {None, "", "N/A"}
        )
    except (
        KeyError,
        IndexError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ) as error:
        raise MediaCommandError(
            ["ffprobe", str(path)],
            0,
            "",
            message="ffprobe returned invalid audio metadata",
        ) from error
    if (
        sample_rate <= 0
        or channels <= 0
        or sample_count <= 0
        or not codec_name
    ):
        raise MediaCommandError(
            ["ffprobe", str(path)],
            0,
            "",
            message="audio has no decodable samples",
        )
    duration = sample_count / sample_rate
    if not math.isfinite(duration):
        raise MediaCommandError(
            ["ffprobe", str(path)],
            0,
            "",
            message="audio duration is invalid",
        )
    return AudioProbe(
        duration=duration,
        sample_rate=sample_rate,
        channels=channels,
        codec_name=codec_name,
        bit_rate=bit_rate,
        sample_count=sample_count,
    )

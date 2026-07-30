"""Normalize, validate, concatenate, and persist text-video speech audio."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
import math
import os
from pathlib import Path
import shutil
import tempfile
from typing import Sequence
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from media_command import AudioProbe, probe_audio, run_media_command
from models import CreativeAsset, TextVideoSpeechAsset
from storage_paths import UPLOADS_DIR


SUPPORTED_MEDIA_TYPES = {"audio/wav", "audio/mpeg"}
TARGET_SAMPLE_RATE = 44100
TARGET_BIT_RATE = 128000


@dataclass(frozen=True)
class MasterAudioAssembly:
    probe: AudioProbe
    sample_offsets: tuple[int, ...]


def _validated_setting(
    name: str,
    value: float,
    minimum: float,
    maximum: float,
) -> float:
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(
            f"{name} must be between {minimum:g} and {maximum:g}",
        )
    return result


def _number(value: float) -> str:
    return f"{value:.12g}"


def audio_tempo_filters(factor: float) -> list[str]:
    value = float(factor)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("atempo factor must be finite and positive")
    filters: list[str] = []
    while value < 0.5 - 1e-12:
        filters.append("atempo=0.5")
        value /= 0.5
    while value > 2 + 1e-12:
        filters.append("atempo=2")
        value /= 2
    if not math.isclose(value, 1, rel_tol=0, abs_tol=1e-12):
        filters.append(f"atempo={_number(value)}")
    return filters


def _compliant_copy(
    probe: AudioProbe,
    *,
    speed: float,
    volume: float,
    pitch: float,
) -> bool:
    return bool(
        probe.codec_name == "mp3"
        and probe.sample_rate == TARGET_SAMPLE_RATE
        and probe.channels == 1
        and abs(probe.bit_rate - TARGET_BIT_RATE) <= 2000
        and speed == 1
        and volume == 1
        and pitch == 0
    )


async def normalize_speech_audio(
    source: Path,
    output: Path,
    *,
    speed: float,
    volume: float,
    pitch: float,
) -> AudioProbe:
    speed = _validated_setting("speed", speed, 0.5, 2)
    volume = _validated_setting("volume", volume, 0, 2)
    pitch = _validated_setting("pitch", pitch, -12, 12)
    source_probe = await probe_audio(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    if _compliant_copy(
        source_probe,
        speed=speed,
        volume=volume,
        pitch=pitch,
    ):
        await asyncio.to_thread(shutil.copyfile, source, output)
        return await probe_audio(output)

    pitch_factor = 2 ** (pitch / 12)
    filters = [
        f"aresample={TARGET_SAMPLE_RATE}",
        "aformat=channel_layouts=mono",
    ]
    if not math.isclose(pitch_factor, 1):
        filters.extend([
            f"asetrate={TARGET_SAMPLE_RATE}*{_number(pitch_factor)}",
            f"aresample={TARGET_SAMPLE_RATE}",
        ])
    filters.extend(audio_tempo_filters(speed / pitch_factor))
    filters.append(f"volume={_number(volume)}")
    await run_media_command([
        "ffmpeg", "-y",
        "-i", str(source),
        "-vn",
        "-af", ",".join(filters),
        "-ar", str(TARGET_SAMPLE_RATE),
        "-ac", "1",
        "-codec:a", "libmp3lame",
        "-b:a", "128k",
        str(output),
    ])
    return await probe_audio(output)


def _concat_line(path: Path) -> str:
    escaped = str(path.resolve()).replace("'", "'\\''")
    return f"file '{escaped}'\n"


async def concatenate_master_audio(
    inputs: Sequence[Path],
    output: Path,
) -> AudioProbe:
    if not inputs:
        raise ValueError("at least one speech audio file is required")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="text-video-concat-",
        dir=output.parent,
    ) as directory_value:
        directory = Path(directory_value)
        pcm_files: list[Path] = []
        for index, source in enumerate(inputs):
            pcm = directory / f"{index:06d}.wav"
            await run_media_command([
                "ffmpeg", "-y",
                "-i", str(source),
                "-vn",
                "-ar", str(TARGET_SAMPLE_RATE),
                "-ac", "1",
                "-codec:a", "pcm_s16le",
                str(pcm),
            ])
            pcm_files.append(pcm)
        concat_file = directory / "inputs.txt"
        concat_file.write_text(
            "".join(_concat_line(path) for path in pcm_files),
            encoding="utf-8",
        )
        await run_media_command([
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_file),
            "-vn",
            "-ar", str(TARGET_SAMPLE_RATE),
            "-ac", "1",
            "-codec:a", "libmp3lame",
            "-b:a", "128k",
            str(output),
        ])
    return await probe_audio(output)


async def assemble_master_audio(
    inputs: Sequence[Path],
    output: Path,
    *,
    expected_sample_counts: Sequence[int],
) -> MasterAudioAssembly:
    if len(inputs) != len(expected_sample_counts) or not inputs:
        raise ValueError("master audio inputs and sample counts must match")
    sample_offsets: list[int] = []
    total = 0
    for source, expected in zip(
        inputs,
        expected_sample_counts,
        strict=True,
    ):
        if (
            isinstance(expected, bool)
            or not isinstance(expected, int)
            or expected <= 0
        ):
            raise ValueError("speech sample count must be a positive integer")
        probe = await probe_audio(source)
        if (
            probe.sample_rate != TARGET_SAMPLE_RATE
            or probe.channels != 1
            or probe.sample_count != expected
        ):
            raise ValueError("speech audio sample metadata does not match")
        sample_offsets.append(total)
        total += expected
    probe = await concatenate_master_audio(inputs, output)
    if (
        probe.sample_rate != TARGET_SAMPLE_RATE
        or probe.channels != 1
        or probe.sample_count != total
    ):
        output.unlink(missing_ok=True)
        raise ValueError("master audio sample count does not match its inputs")
    return MasterAudioAssembly(
        probe=probe,
        sample_offsets=tuple(sample_offsets),
    )


def _validated_timings(
    value: Sequence[dict] | None,
    *,
    duration: float,
) -> list[dict]:
    timings: list[dict] = []
    previous_end = 0.0
    identifiers: set[str] = set()
    for raw in value or []:
        if not isinstance(raw, dict):
            raise ValueError("word timing must be an object")
        identifier = raw.get("id")
        text = raw.get("text")
        if (
            isinstance(raw.get("start"), bool)
            or isinstance(raw.get("end"), bool)
        ):
            raise ValueError("word timing range is invalid")
        try:
            start = float(raw.get("start"))
            end = float(raw.get("end"))
        except (TypeError, ValueError) as error:
            raise ValueError("word timing range is invalid") from error
        if (
            not isinstance(identifier, str)
            or not identifier
            or not isinstance(text, str)
            or not text
            or identifier in identifiers
            or not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end <= start
            or start < previous_end
            or end > duration + 1e-6
        ):
            raise ValueError("word timing range is invalid")
        timings.append({
            "id": identifier,
            "text": text,
            "start": start,
            "end": end,
        })
        identifiers.add(identifier)
        previous_end = end
    return timings


async def save_text_video_audio_asset(
    db: AsyncSession,
    source: Path,
    *,
    source_hash: str,
    media_type: str,
    speed: float,
    volume: float,
    pitch: float,
    word_timings: Sequence[dict] | None,
    provider_request_id: str,
) -> dict:
    if media_type not in SUPPORTED_MEDIA_TYPES:
        raise ValueError("unsupported speech audio MIME type")
    if len(source_hash) != 64:
        raise ValueError("source_hash must contain 64 characters")
    source_probe = await probe_audio(source)
    timings = _validated_timings(
        word_timings,
        duration=source_probe.duration,
    )
    uploads = Path(UPLOADS_DIR)
    uploads.mkdir(parents=True, exist_ok=True)
    temporary_directory = uploads / ".speech-tmp"
    temporary_directory.mkdir(parents=True, exist_ok=True)
    identifier = uuid4().hex
    normalized = temporary_directory / f"{identifier}.mp3"
    final = uploads / f"{identifier}.mp3"
    moved = False
    try:
        normalized_probe = await normalize_speech_audio(
            source,
            normalized,
            speed=speed,
            volume=volume,
            pitch=pitch,
        )
        scale = normalized_probe.duration / source_probe.duration
        scaled_timings = [
            {
                **timing,
                "start": timing["start"] * scale,
                "end": timing["end"] * scale,
            }
            for timing in timings
        ]
        scaled_timings = _validated_timings(
            scaled_timings,
            duration=normalized_probe.duration,
        )
        os.replace(normalized, final)
        moved = True
        asset = CreativeAsset(
            asset_type="media",
            media_kind="audio",
            title="文字视频口播配音",
            url=f"/api/uploads/{final.name}",
            media_type="audio/mpeg",
            filename=final.name,
            source="generated",
        )
        db.add(asset)
        await db.flush()
        metadata = TextVideoSpeechAsset(
            creative_asset_id=asset.id,
            source_hash=source_hash,
            duration=normalized_probe.duration,
            sample_count=normalized_probe.sample_count,
            sample_rate=normalized_probe.sample_rate,
            word_timings=deepcopy(scaled_timings),
            provider_request_id=provider_request_id[:500],
        )
        db.add(metadata)
        await db.flush()
        return {
            "asset_id": asset.id,
            "audio_url": asset.url,
            "duration": (
                normalized_probe.sample_count
                / normalized_probe.sample_rate
            ),
            "sample_count": normalized_probe.sample_count,
            "sample_rate": normalized_probe.sample_rate,
            "word_timings": scaled_timings,
            "provider_request_id": metadata.provider_request_id,
        }
    except BaseException:
        if moved:
            final.unlink(missing_ok=True)
        raise
    finally:
        normalized.unlink(missing_ok=True)

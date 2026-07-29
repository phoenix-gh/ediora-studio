import asyncio
import os
from pathlib import Path
import sys

import pytest

from media_command import (
    MediaCommandError,
    MediaToolUnavailable,
    probe_audio,
    run_media_command,
)
from tests.text_video_factories import run_async


async def sine_wave(
    path: Path,
    *,
    frequency: int = 440,
    seconds: float = 1.0,
    sample_rate: int = 44100,
    channels: int = 1,
) -> Path:
    await run_media_command([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", f"sine=frequency={frequency}:duration={seconds}",
        "-ar", str(sample_rate), "-ac", str(channels), str(path),
    ])
    return path


def test_probe_audio_counts_decoded_samples_in_a_path_with_spaces(tmp_path):
    async def run():
        directory = tmp_path / "media with spaces"
        directory.mkdir()
        source = await sine_wave(directory / "one second.wav")
        probe = await probe_audio(source)

        assert probe.sample_rate == 44100
        assert probe.channels == 1
        assert probe.codec_name == "pcm_s16le"
        assert probe.sample_count == 44100
        assert probe.duration == 1

    run_async(run())


def test_media_command_reports_missing_tools_without_shell_fallback():
    with pytest.raises(MediaToolUnavailable, match="not installed"):
        run_async(run_media_command(["definitely-not-a-real-media-tool"]))


def test_media_command_times_out_and_redacts_stderr():
    with pytest.raises(MediaCommandError, match="timed out") as captured:
        run_async(run_media_command([
            sys.executable,
            "-c",
            "import sys,time;sys.stderr.write('api_key=super-secret');"
            "sys.stderr.flush();time.sleep(60)",
        ], timeout=0.05))

    assert "super-secret" not in str(captured.value)


def test_media_command_kills_and_reaps_child_when_cancelled(tmp_path):
    async def run():
        pid_path = tmp_path / "child.pid"
        task = asyncio.create_task(run_media_command([
            sys.executable,
            "-c",
            "import os,pathlib,time;"
            f"pathlib.Path({str(pid_path)!r}).write_text(str(os.getpid()));"
            "time.sleep(60)",
        ]))
        for _ in range(100):
            if pid_path.exists():
                break
            await asyncio.sleep(0.01)
        pid = int(pid_path.read_text())
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)

    run_async(run())


def test_probe_rejects_corrupt_audio(tmp_path):
    source = tmp_path / "corrupt.wav"
    source.write_bytes(b"not audio")
    with pytest.raises(MediaCommandError):
        run_async(probe_audio(source))

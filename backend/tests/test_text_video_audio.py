import json
from pathlib import Path
import sys

import pytest

from media_command import probe_audio, run_media_command
from tests.test_media_command import sine_wave
from tests.text_video_factories import fresh_session_factory, run_async
from text_video_audio import (
    audio_tempo_filters,
    assemble_master_audio,
    concatenate_master_audio,
    normalize_speech_audio,
)


@pytest.mark.parametrize(
    ("factor", "expected"),
    [
        (0.25, ["atempo=0.5", "atempo=0.5"]),
        (1, []),
        (4, ["atempo=2", "atempo=2"]),
    ],
)
def test_atempo_factors_are_split_into_ffmpeg_supported_ranges(
    factor,
    expected,
):
    assert audio_tempo_filters(factor) == expected


def test_normalize_speech_audio_applies_target_encoding_and_settings(
    tmp_path,
):
    async def run():
        source = await sine_wave(
            tmp_path / "source.wav",
            seconds=1.0,
            sample_rate=24000,
            channels=2,
        )
        output = tmp_path / "normalized.mp3"
        await normalize_speech_audio(
            source,
            output,
            speed=1.0,
            volume=1.0,
            pitch=0.0,
        )
        probe = await probe_audio(output)
        assert probe.sample_rate == 44100
        assert probe.channels == 1
        assert probe.codec_name == "mp3"
        assert probe.bit_rate == pytest.approx(128000, abs=2000)
        assert probe.sample_count == pytest.approx(44100, abs=1)
        assert probe.duration == pytest.approx(1.0, abs=0.001)

    run_async(run())


@pytest.mark.parametrize(
    ("speed", "pitch", "expected_duration"),
    [
        (0.5, 0, 2.0),
        (2.0, 0, 0.5),
        (1.0, -12, 1.0),
        (1.0, 12, 1.0),
    ],
)
def test_normalize_speed_and_pitch_have_deterministic_duration(
    tmp_path,
    speed,
    pitch,
    expected_duration,
):
    async def run():
        source = await sine_wave(tmp_path / f"source-{speed}-{pitch}.wav")
        output = tmp_path / f"normalized-{speed}-{pitch}.mp3"
        await normalize_speech_audio(
            source,
            output,
            speed=speed,
            volume=1,
            pitch=pitch,
        )
        assert (await probe_audio(output)).duration == pytest.approx(
            expected_duration,
            abs=0.03,
        )

    run_async(run())


def test_compliant_mp3_is_copied_byte_for_byte(tmp_path):
    async def run():
        wav = await sine_wave(tmp_path / "source.wav")
        source = tmp_path / "source.mp3"
        await run_media_command([
            "ffmpeg", "-y", "-i", str(wav),
            "-ar", "44100", "-ac", "1",
            "-codec:a", "libmp3lame", "-b:a", "128k",
            str(source),
        ])
        output = tmp_path / "copy.mp3"

        await normalize_speech_audio(
            source,
            output,
            speed=1,
            volume=1,
            pitch=0,
        )

        assert output.read_bytes() == source.read_bytes()

    run_async(run())


def test_concat_preserves_order_and_real_duration(tmp_path):
    async def run():
        first = await sine_wave(
            tmp_path / "first.wav",
            frequency=330,
            seconds=0.6,
        )
        second = await sine_wave(
            tmp_path / "second.wav",
            frequency=660,
            seconds=0.9,
        )
        output = tmp_path / "master.mp3"
        await concatenate_master_audio([first, second], output)
        probe = await probe_audio(output)
        assert probe.duration == pytest.approx(1.5, abs=0.002)
        assert probe.sample_count == pytest.approx(66150, abs=1)

    run_async(run())


def test_master_assembly_uses_persisted_sample_counts_for_exact_offsets(
    tmp_path,
):
    async def run():
        first = await sine_wave(
            tmp_path / "first-exact.wav",
            seconds=1.0,
        )
        second = await sine_wave(
            tmp_path / "second-exact.wav",
            seconds=1.5,
        )
        first_mp3 = tmp_path / "first-exact.mp3"
        second_mp3 = tmp_path / "second-exact.mp3"
        await normalize_speech_audio(
            first,
            first_mp3,
            speed=1,
            volume=1,
            pitch=0,
        )
        await normalize_speech_audio(
            second,
            second_mp3,
            speed=1,
            volume=1,
            pitch=0,
        )

        assembled = await assemble_master_audio(
            [first_mp3, second_mp3],
            tmp_path / "master-exact.mp3",
            expected_sample_counts=[44100, 66150],
        )

        assert assembled.sample_offsets == (0, 44100)
        assert assembled.probe.sample_count == 110250
        assert assembled.probe.duration == 2.5

    run_async(run())


def test_many_short_mp3_inputs_do_not_accumulate_container_duration_drift(
    tmp_path,
):
    async def run():
        inputs = []
        expected = []
        for index in range(12):
            wav = await sine_wave(
                tmp_path / f"short-{index}.wav",
                seconds=0.1,
            )
            mp3 = tmp_path / f"short-{index}.mp3"
            await normalize_speech_audio(
                wav,
                mp3,
                speed=1,
                volume=1,
                pitch=0,
            )
            inputs.append(mp3)
            expected.append(4410)

        assembled = await assemble_master_audio(
            inputs,
            tmp_path / "short-master.mp3",
            expected_sample_counts=expected,
        )

        assert assembled.sample_offsets == tuple(
            index * 4410 for index in range(12)
        )
        assert assembled.probe.sample_count == 52920
        assert assembled.probe.duration == 1.2

    run_async(run())


def test_decoded_duration_excludes_mp3_container_padding(tmp_path):
    async def run():
        source = await sine_wave(tmp_path / "source.wav")
        output = tmp_path / "normalized.mp3"
        await normalize_speech_audio(
            source,
            output,
            speed=1,
            volume=1,
            pitch=0,
        )
        decoded = await probe_audio(output)
        raw = json.loads((await run_media_command([
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json", str(output),
        ])).decode())
        container_duration = float(raw["format"]["duration"])

        assert decoded.duration == 1
        assert container_duration > decoded.duration

    run_async(run())


def test_save_audio_persists_sample_accurate_asset_and_scales_timings(
    monkeypatch,
    tmp_path,
    postgres_database_url,
):
    for module in ("database", "models", "text_video_audio"):
        sys.modules.pop(module, None)
    session_factory = fresh_session_factory(
        monkeypatch,
        postgres_database_url,
    )
    import text_video_audio
    from models import CreativeAsset, TextVideoSpeechAsset

    uploads = tmp_path / "uploads root"
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", uploads)

    async def run():
        source = await sine_wave(tmp_path / "provider.wav", seconds=1)
        async with session_factory() as session:
            saved = await text_video_audio.save_text_video_audio_asset(
                session,
                source,
                source_hash="a" * 64,
                media_type="audio/wav",
                speed=2,
                volume=1,
                pitch=0,
                word_timings=[
                    {"id": "w1", "text": "测试", "start": 0, "end": 0.8},
                ],
                provider_request_id="provider-1",
            )
            await session.commit()
            asset = await session.get(CreativeAsset, saved["asset_id"])
            metadata = await session.scalar(
                __import__("sqlalchemy").select(TextVideoSpeechAsset),
            )

            assert asset.media_type == "audio/mpeg"
            assert asset.url == saved["audio_url"]
            assert (uploads / Path(asset.url).name).is_file()
            assert metadata.sample_rate == 44100
            assert metadata.sample_count > 0
            assert saved["duration"] == pytest.approx(0.5, abs=0.02)
            assert saved["duration"] == (
                metadata.sample_count / metadata.sample_rate
            )
            assert saved["word_timings"][0]["end"] == pytest.approx(
                0.4,
                abs=0.01,
            )

    run_async(run())


@pytest.mark.parametrize(
    "timings",
    [
        [{"id": "a", "text": "a", "start": float("nan"), "end": 0.2}],
        [{"id": "a", "text": "a", "start": 0, "end": float("inf")}],
        [
            {"id": "a", "text": "a", "start": 0, "end": 0.7},
            {"id": "b", "text": "b", "start": 0.6, "end": 0.9},
        ],
        [{"id": "a", "text": "a", "start": 0, "end": 2}],
        [{"id": "a", "text": "a", "start": True, "end": 0.2}],
        [{"id": "a", "text": "a", "start": 0.2, "end": 0.2}],
        [{"id": "a", "text": "", "start": 0, "end": 0.2}],
        [
            {"id": "a", "text": "a", "start": 0, "end": 0.2},
            {"id": "a", "text": "b", "start": 0.2, "end": 0.4},
        ],
    ],
)
def test_save_rejects_invalid_provider_timings(
    monkeypatch,
    tmp_path,
    postgres_database_url,
    timings,
):
    sys.modules.pop("text_video_audio", None)
    session_factory = fresh_session_factory(
        monkeypatch,
        postgres_database_url,
    )
    import text_video_audio
    monkeypatch.setattr(text_video_audio, "UPLOADS_DIR", tmp_path / "uploads")

    async def run():
        source = await sine_wave(tmp_path / "provider.wav", seconds=1)
        async with session_factory() as session:
            with pytest.raises(ValueError, match="word timing"):
                await text_video_audio.save_text_video_audio_asset(
                    session,
                    source,
                    source_hash="a" * 64,
                    media_type="audio/wav",
                    speed=1,
                    volume=1,
                    pitch=0,
                    word_timings=timings,
                    provider_request_id="",
                )

    run_async(run())


def test_speech_asset_migration_adds_sample_metadata(
    monkeypatch,
    postgres_database_url,
):
    monkeypatch.setenv("WMS_DATABASE_URL", postgres_database_url)
    for module in ("database",):
        sys.modules.pop(module, None)
    from database import migrate_text_video_speech_asset_schema
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    async def run():
        engine = create_async_engine(postgres_database_url)
        async with engine.begin() as connection:
            await connection.execute(text(
                "CREATE TABLE text_video_speech_assets ("
                "id INTEGER PRIMARY KEY, duration FLOAT NOT NULL)"
            ))
            await connection.execute(text(
                "INSERT INTO text_video_speech_assets (id, duration) "
                "VALUES (1, 1.25)"
            ))
            await migrate_text_video_speech_asset_schema(connection)
            await migrate_text_video_speech_asset_schema(connection)
            row = (
                await connection.execute(text(
                    "SELECT sample_count, sample_rate "
                    "FROM text_video_speech_assets WHERE id = 1"
                ))
            ).one()
        assert row == (0, 44100)
        await engine.dispose()

    run_async(run())

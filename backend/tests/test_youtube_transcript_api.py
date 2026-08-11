from datetime import datetime, timezone


def make_video(**overrides):
    from models import YoutubeVideo

    values = {
        "id": "video-1",
        "channel_id": "channel-1",
        "published_at": datetime.now(timezone.utc),
        "transcript_status": "ready",
        "transcript_source": "manual",
        "transcript_language": "en",
        "transcript_text": "Original text",
        "transcript_segments": [{"start": 0, "end": 1, "text": "Original text"}],
        "transcript_content_hash": "original-hash",
    }
    values.update(overrides)
    return YoutubeVideo(**values)


def test_transcript_payload_returns_no_chinese_variant_for_existing_rows():
    from routers.youtube import transcript_payload

    assert transcript_payload(make_video())["chinese"] is None


def test_transcript_payload_exposes_populated_chinese_variant():
    from routers.youtube import transcript_payload

    payload = transcript_payload(make_video(
        transcript_zh_source="auto",
        transcript_zh_language="zh-Hans",
        transcript_zh_text="中文字幕",
        transcript_zh_segments=[{"start": 0, "end": 1, "text": "中文字幕"}],
        transcript_zh_content_hash="zh-hash",
    ))

    assert payload["text"] == "Original text"
    assert payload["chinese"] == {
        "source": "auto",
        "language": "zh-Hans",
        "text": "中文字幕",
        "segments": [{"start": 0, "end": 1, "text": "中文字幕"}],
        "content_hash": "zh-hash",
    }


def test_transcript_payload_normalizes_legacy_cue_segments_for_bilingual_view():
    """Catches old stored caption cues bypassing sentence-level display."""
    from routers.youtube import transcript_payload

    payload = transcript_payload(make_video(
        transcript_text="First sentence. Second sentence!",
        transcript_segments=[
            {"start": 0, "end": 1, "text": "First"},
            {"start": 1, "end": 2, "text": "sentence."},
            {"start": 2, "end": 3, "text": "Second"},
            {"start": 3, "end": 4, "text": "sentence!"},
        ],
        transcript_zh_source="auto",
        transcript_zh_language="zh-Hans",
        transcript_zh_text="第一句话。第二句话！",
        transcript_zh_segments=[
            {"start": 0, "end": 1, "text": "第一"},
            {"start": 1, "end": 2, "text": "句话。"},
            {"start": 2, "end": 3, "text": "第二句话！"},
        ],
    ))

    assert payload["text"] == "First sentence.\nSecond sentence!"
    assert payload["segments"] == [
        {"start": 0.0, "end": 2.0, "text": "First sentence."},
        {"start": 2.0, "end": 4.0, "text": "Second sentence!"},
    ]
    assert payload["chinese"]["text"] == "第一句话。\n第二句话！"
    assert payload["chinese"]["segments"] == [
        {"start": 0.0, "end": 2.0, "text": "第一句话。"},
        {"start": 2.0, "end": 3.0, "text": "第二句话！"},
    ]


def test_video_list_payload_excludes_all_full_transcript_content():
    from routers.youtube import video_list_payload

    payload = video_list_payload(make_video(
        transcript_zh_text="中文字幕",
        transcript_zh_segments=[{"start": 0, "end": 1, "text": "中文字幕"}],
    ), None)

    assert "transcript_text" not in payload
    assert "transcript_segments" not in payload
    assert "transcript_zh_text" not in payload
    assert "transcript_zh_segments" not in payload

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

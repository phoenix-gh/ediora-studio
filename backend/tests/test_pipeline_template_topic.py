import pytest
from pipeline_template import get_pipeline, FULL_PIPELINE

SAMPLE_CTX = {
    "title": "AI 大模型趋势",
    "account_id": "acc_1",
    "account_profile": {
        "name": "测试号",
        "platform": "x",
        "positioning": "AI 观察",
        "audience": "技术人",
        "tone": "犀利",
        "topic_focus": ["AI"],
        "taboo": [],
        "word_range": {"min": 1500, "max": 3000},
        "image_style": "简约",
        "cover_style": {},
        "voice_samples": [],
        "style_rules": [],
    },
    "content_type": "long",
    "content_type_label": "长文",
    "word_range": "1500-3000 字",
    "angle": "GPT-4o 发布后开发者工具链的变迁",
    "source_posts_md": "- @openai: GPT-4o is here [https://x.com/1]",
    "pipeline_task_id": 42,
    "draft_id": 0,
}


def test_topic_long_has_three_steps():
    steps = get_pipeline("topic_long")
    assert len(steps) == 3
    assert [s.assignee for s in steps] == ["wms_editor", "wms_writer", "wms_illustrator"]


def test_topic_long_editor_body_contains_angle_and_source_posts():
    steps = get_pipeline("topic_long")
    body = steps[0].body(SAMPLE_CTX)
    assert "GPT-4o 发布后开发者工具链的变迁" in body
    assert "@openai" in body
    assert "wms_editor" not in body  # sanity — body is content, not metadata


def test_topic_long_editor_body_contains_word_range():
    steps = get_pipeline("topic_long")
    body = steps[0].body(SAMPLE_CTX)
    assert "1500-3000 字" in body


def test_topic_long_writer_and_illustrator_same_as_full():
    topic_steps = get_pipeline("topic_long")
    assert topic_steps[1] is FULL_PIPELINE[1]
    assert topic_steps[2] is FULL_PIPELINE[2]


def test_topic_short_has_one_writer_step():
    steps = get_pipeline("topic_short")
    assert len(steps) == 1
    assert steps[0].assignee == "wms_writer"


def test_topic_short_story_body_contains_sentence_count():
    ctx = {**SAMPLE_CTX, "content_type": "story", "content_type_label": "微故事"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "5-6 句话" in body


def test_topic_short_share_body_contains_sentence_count():
    ctx = {**SAMPLE_CTX, "content_type": "share", "content_type_label": "发现"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "3-5 句话" in body


def test_topic_short_short_body_contains_word_count():
    ctx = {**SAMPLE_CTX, "content_type": "short", "content_type_label": "短文", "word_range": "200-500 字"}
    steps = get_pipeline("topic_short")
    body = steps[0].body(ctx)
    assert "200-500 字" in body


def test_topic_short_body_contains_angle_and_pipeline_task_id():
    steps = get_pipeline("topic_short")
    body = steps[0].body(SAMPLE_CTX)
    assert "GPT-4o 发布后开发者工具链的变迁" in body
    assert "42" in body  # pipeline_task_id


def test_unknown_pipeline_raises():
    with pytest.raises(ValueError, match="unknown flow"):
        get_pipeline("nonexistent")

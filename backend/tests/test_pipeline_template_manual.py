import pytest
from pipeline_template import get_pipeline, FULL_PIPELINE

MANUAL_CTX = {
    "title": "为什么本地优先软件又火了",
    "account_id": "acc_1",
    "account_profile": {
        "name": "测试号",
        "platform": "wechat",
        "positioning": "AI 观察",
        "audience": "技术人",
        "tone": "犀利",
        "topic_focus": ["AI"],
        "taboo": ["政治"],
        "word_range": {"min": 1500, "max": 2200},
        "image_style": "简约",
        "cover_style": {},
        "voice_samples": [],
        "style_rules": [],
    },
    "idea": "想从 CRDT 落地难讲起，顺带提一下 linear 的同步引擎",
    "genre": "commentary",
    "genre_label": "评论",
    "note": "别写成科普",
    "pipeline_task_id": 42,
    "draft_id": 0,
}


def test_manual_topic_has_three_steps():
    steps = get_pipeline("manual_topic")
    assert len(steps) == 3
    assert [s.assignee for s in steps] == ["wms_editor", "wms_writer", "wms_illustrator"]


def test_manual_topic_writer_and_illustrator_same_as_full():
    steps = get_pipeline("manual_topic")
    assert steps[1] is FULL_PIPELINE[1]
    assert steps[2] is FULL_PIPELINE[2]


def test_manual_editor_body_contains_title_idea_and_note():
    body = get_pipeline("manual_topic")[0].body(MANUAL_CTX)
    assert "为什么本地优先软件又火了" in body
    assert "CRDT 落地难" in body
    assert "别写成科普" in body


def test_manual_editor_body_contains_genre_and_profile():
    body = get_pipeline("manual_topic")[0].body(MANUAL_CTX)
    assert "评论" in body
    assert "账号画像" in body   # render_profile_editor 块
    assert "政治" in body       # taboo 透传


def test_manual_editor_body_instructs_web_research_when_idea_empty():
    ctx = {**MANUAL_CTX, "idea": "", "note": ""}
    body = get_pipeline("manual_topic")[0].body(ctx)
    assert "web 工具" in body          # 素材不足要自己搜
    assert "用户只给了主题" in body    # 空想法占位提示
    assert "别写成科普" not in body


def test_manual_editor_body_has_brief_contract():
    body = get_pipeline("manual_topic")[0].body(MANUAL_CTX)
    assert "core_point" in body
    assert "brief_md" in body          # kanban_complete metadata 契约
    assert "候选锚点" in body

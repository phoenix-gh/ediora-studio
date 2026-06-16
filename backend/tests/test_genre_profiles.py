from pipeline_template import GENRE_PROFILES, _genre_profile


def test_four_genres_present():
    assert set(GENRE_PROFILES) == {"commentary", "tutorial", "story", "review"}


def test_commentary_flags():
    p = GENRE_PROFILES["commentary"]
    assert p.first_person is True and p.humanizer is True
    assert p.label == "评论"


def test_tutorial_flags_and_structure():
    p = GENRE_PROFILES["tutorial"]
    assert p.first_person is False and p.humanizer is False
    assert "编号步骤" in p.structure_md
    assert "禁令对本文体作废" in p.structure_md  # 平行结构作废


def test_review_flags():
    p = GENRE_PROFILES["review"]
    assert p.first_person is False and p.humanizer is False


def test_genre_profile_defaults_to_commentary():
    assert _genre_profile({}).key == "commentary"
    assert _genre_profile({"genre": None}).key == "commentary"
    assert _genre_profile({"genre": "nope"}).key == "commentary"
    assert _genre_profile({"genre": "tutorial"}).key == "tutorial"


# ── Task 3: writer_rules_md 按文体分流 ──────────────────────────────────────
from pipeline_template import writer_rules_md
from prompt_templates import load


def test_commentary_long_is_exact_regression():
    # commentary 长文 == 通用词汇块 + 长文结构块（逐字）
    expected = load("writer/wording_rules.md") + "\n\n" + load("writer/structure_longform.md")
    assert writer_rules_md({"genre": "commentary"}) == expected
    assert writer_rules_md({}) == expected  # 缺省也走 commentary


def test_commentary_short_keeps_shortform():
    out = writer_rules_md({"genre": "commentary", "word_spec": {"max": 200, "raw": "100-200 字"}})
    assert "短文案结构" in out
    assert "≤ 200 字" in out


def test_tutorial_uses_tutorial_block_not_longform():
    out = writer_rules_md({"genre": "tutorial"})
    assert "教程 / 操作指南结构" in out
    assert "第一人称当下动作" not in out  # 长文强制具体化块不在
    assert "通用反 AI 腔" in out          # 通用词汇块仍在


def test_tutorial_short_appends_wordcap():
    out = writer_rules_md({"genre": "tutorial", "word_spec": {"max": 400, "raw": "400 字以内"}})
    assert "≤ 400 字" in out
    assert "教程 / 操作指南结构" in out


# ── Task 4: writer body 按文体 gate ─────────────────────────────────────────
from pipeline_template import FULL_PIPELINE

_WRITER_STEP = FULL_PIPELINE[1]


def _writer_body(genre):
    ctx = {
        "title": "T", "account_id": "a", "pipeline_task_id": 1,
        "account_profile": {"name": "n", "platform": "wechat"},
        "genre": genre,
    }
    return _WRITER_STEP.body(ctx)


def test_commentary_body_keeps_humanizer_and_first_person():
    b = _writer_body("commentary")
    assert "使用技能**: humanizer" in b
    assert "第一人称的当下动作" in b
    assert "拒绝每节等深等宽的对称结构" in b


def test_tutorial_body_drops_humanizer_first_person_and_symmetry():
    b = _writer_body("tutorial")
    assert "humanizer" not in b
    assert "第一人称的当下动作" not in b
    assert "拒绝每节等深等宽的对称结构" not in b
    assert "不写第一人称经历" in b           # 中立锚点提示
    assert "步骤 / 维度该等重" in b           # 中立结构提示


# ── Task 5: plan_editor_task_block 按文体分流 ───────────────────────────────
from pipeline_template import plan_editor_task_block


def test_editor_block_commentary_is_hotspot_framing():
    b = plan_editor_task_block("commentary", plan_id=7, word_rule_line="严格按写作模式字数")
    assert "找今天的素材" in b
    assert "add_plan_source(plan_id=7" in b
    assert "第一人称可代入" in b


def test_editor_block_tutorial_is_procedure_framing():
    b = plan_editor_task_block("tutorial", plan_id=7, word_rule_line="严格按写作模式字数")
    assert "找今天的素材" not in b
    assert "讲准" in b
    assert "第一人称可代入" not in b          # 不推第一人称锚点
    assert "add_plan_source(plan_id=7" in b  # 线索库仍可用
